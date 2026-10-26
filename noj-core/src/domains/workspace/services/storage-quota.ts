import { and, eq, sql } from "drizzle-orm";
import { AppError, ConflictError } from "../../../shared/base/errors.ts";
import { getDb } from "../../../shared/db/connection.ts";
import type { Executor, RootDb } from "../../../shared/db/executor.ts";
import {
  domainResourceCounters,
  domainStorageObjects,
  domainStorageUploads,
  storageObjects,
} from "../../../shared/db/schema.ts";
import { unwrapRows } from "../../../shared/base/sql-rows.ts";
import { getDomainEffectiveLimits } from "./limits.ts";

const TTL_MS = 15 * 60 * 1000;

function ownedReferences(domainId: string) {
  return sql`SELECT o.storage_url FROM problem_draft_objects o JOIN problems p ON p.id=o.problem_id WHERE p.domain_id=${domainId}
    UNION SELECT o.storage_url FROM problem_version_objects o JOIN problem_versions v ON v.id=o.version_id JOIN problems p ON p.id=v.problem_id WHERE p.domain_id=${domainId}
    UNION SELECT artifact_storage_url FROM submissions WHERE domain_id=${domainId} AND artifact_storage_url IS NOT NULL
    UNION SELECT image_storage_url FROM carousel_slides WHERE domain_id=${domainId} AND image_storage_url IS NOT NULL`;
}

/** 已登记大小的存量源对象纳入所属域；目标域共享绑定没有字节复制或额外计量。 */
async function initializeOwnedObjects(domainId: string, tx: Executor) {
  const references = ownedReferences(domainId);
  await tx.execute(
    sql`INSERT INTO domain_storage_objects(domain_id,storage_url,byte_size,created_at)
    SELECT ${domainId},o.storage_url,o.byte_size,${new Date().toISOString()}
    FROM (${references}) r JOIN storage_objects o ON o.storage_url=r.storage_url
    WHERE o.byte_size IS NOT NULL AND o.state<>'deleted'
    ON CONFLICT(domain_id,storage_url) DO NOTHING`,
  );
  const [result] = unwrapRows<{ used: number | string; unknown: number }>(
    (await tx.execute(sql`SELECT
    (SELECT COALESCE(sum(byte_size),0)::bigint FROM domain_storage_objects WHERE domain_id=${domainId}) AS used,
    (SELECT count(*)::int FROM (${references}) r LEFT JOIN storage_objects o ON o.storage_url=r.storage_url
      WHERE o.storage_url IS NULL OR (o.byte_size IS NULL AND o.state<>'deleted')) AS unknown`)) as never,
  );
  return { used: Number(result.used), unknown: result.unknown };
}

function size(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AppError("上传字节数必须为非负整数", 400, "INVALID_STORAGE_SIZE");
  }
}

/** 锁定域计数后先释放过期预约；多个进程共用持久事实，不使用进程内计数。 */
async function lockQuota(domainId: string, tx: Executor) {
  // 初始化建立对象外键先于计数锁；删除链也按对象 → 计数顺序执行。
  const baseline = await initializeOwnedObjects(domainId, tx);
  await tx.insert(domainResourceCounters).values({
    domain_id: domainId,
    resource: "storage_bytes",
  }).onConflictDoNothing();
  const [counter] = await tx.select().from(domainResourceCounters).where(and(
    eq(domainResourceCounters.domain_id, domainId),
    eq(domainResourceCounters.resource, "storage_bytes"),
  )).for("update");
  // 初始化可能等待其他结算，取得计数锁后重读已提交的实际归属。
  const [current] = unwrapRows<{ used: number | string }>(
    (await tx.execute(
      sql`SELECT COALESCE(sum(byte_size),0)::bigint AS used FROM domain_storage_objects WHERE domain_id=${domainId}`,
    )) as never,
  );
  baseline.used = Number(current.used);
  if (counter.used !== baseline.used) {
    counter.used = baseline.used;
    await tx.update(domainResourceCounters).set({ used: baseline.used }).where(
      and(
        eq(domainResourceCounters.domain_id, domainId),
        eq(domainResourceCounters.resource, "storage_bytes"),
      ),
    );
  }
  const now = new Date().toISOString();
  const expired = await tx.update(domainStorageUploads).set({
    state: "released",
    finished_at: now,
  })
    .where(
      sql`${domainStorageUploads.domain_id} = ${domainId} AND ${domainStorageUploads.state} = 'reserved' AND ${domainStorageUploads.storage_url} IS NULL AND ${domainStorageUploads.expires_at} <= ${now}`,
    )
    .returning({ bytes: domainStorageUploads.byte_size });
  const released = expired.reduce((sum, row) => sum + row.bytes, 0);
  if (released) {
    counter.reserved -= released;
    await tx.update(domainResourceCounters).set({ reserved: counter.reserved })
      .where(and(
        eq(domainResourceCounters.domain_id, domainId),
        eq(domainResourceCounters.resource, "storage_bytes"),
      ));
  }
  const { effective } = await getDomainEffectiveLimits(domainId, tx);
  if (effective.storage_bytes !== null && baseline.unknown > 0) {
    throw new ConflictError(
      "存量存储对象大小尚未核实，请先执行存储核对",
      "DOMAIN_STORAGE_BASELINE_REQUIRED",
    );
  }
  return { ...counter, limit: effective.storage_bytes };
}

function capacity(
  used: number,
  reserved: number,
  extra: number,
  limit: number | null,
) {
  if (extra > 0 && limit !== null && used + reserved + extra > limit) {
    throw new AppError("域存储容量不足", 429, "DOMAIN_STORAGE_LIMIT");
  }
}

async function updateCounter(
  domainId: string,
  tx: Executor,
  used: number,
  reserved: number,
) {
  await tx.update(domainResourceCounters).set({ used, reserved }).where(and(
    eq(domainResourceCounters.domain_id, domainId),
    eq(domainResourceCounters.resource, "storage_bytes"),
  ));
}

/** 仅可信上传链调用：在写入物理字节前预留已知容量，ID 可供内部重试复用。 */
export async function reserveDomainStorageUpload(
  input: {
    domainId: string;
    bytes: number;
    id?: string;
    ttlMs?: number;
    storageUrl?: string;
  },
  executor?: Executor,
) {
  size(input.bytes);
  return await ((executor ?? getDb()) as RootDb).transaction(async (tx) => {
    // 内容已知的上传在写入前留下对象定位；崩溃后核对物理对象再释放预约。
    if (input.storageUrl) {
      await tx.select().from(storageObjects).where(
        eq(storageObjects.storage_url, input.storageUrl),
      ).for("share");
    }
    const quota = await lockQuota(input.domainId, tx),
      id = input.id ?? crypto.randomUUID();
    const [existing] = await tx.select().from(domainStorageUploads).where(
      eq(domainStorageUploads.id, id),
    );
    if (existing) {
      if (
        existing.domain_id !== input.domainId ||
        existing.byte_size !== input.bytes ||
        existing.storage_url !== (input.storageUrl ?? null)
      ) {
        throw new ConflictError(
          "上传预约的幂等依据不一致",
          "STORAGE_RESERVATION_CONFLICT",
        );
      }
      if (existing.state === "released") {
        throw new ConflictError(
          "上传预约已释放",
          "STORAGE_RESERVATION_EXPIRED",
        );
      }
      return existing;
    }
    capacity(quota.used, quota.reserved, input.bytes, quota.limit);
    const now = new Date(), ttl = input.ttlMs ?? TTL_MS;
    const [reservation] = await tx.insert(domainStorageUploads).values({
      id,
      domain_id: input.domainId,
      byte_size: input.bytes,
      storage_url: input.storageUrl ?? null,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + ttl).toISOString(),
    }).returning();
    await updateCounter(
      input.domainId,
      tx,
      quota.used,
      quota.reserved + input.bytes,
    );
    return reservation;
  });
}

/** 流式上传在每批字节交给存储前增补容量，并延长活跃预约；超额先于物理写入失败。 */
export async function growDomainStorageUpload(
  domainId: string,
  id: string,
  extraBytes: number,
) {
  size(extraBytes);
  return await getDb().transaction(async (tx) => {
    const quota = await lockQuota(domainId, tx);
    const [upload] = await tx.select().from(domainStorageUploads).where(
      and(
        eq(domainStorageUploads.id, id),
        eq(domainStorageUploads.domain_id, domainId),
      ),
    );
    if (!upload || upload.state !== "reserved") {
      throw new ConflictError("上传预约已失效", "STORAGE_RESERVATION_EXPIRED");
    }
    capacity(quota.used, quota.reserved, extraBytes, quota.limit);
    const [updated] = await tx.update(domainStorageUploads).set({
      byte_size: upload.byte_size + extraBytes,
      expires_at: new Date(Date.now() + TTL_MS).toISOString(),
    }).where(eq(domainStorageUploads.id, id)).returning();
    await updateCounter(domainId, tx, quota.used, quota.reserved + extraBytes);
    return updated;
  });
}

/** 存储登记后以实际对象大小结算；同域内容寻址对象只计一次，重复结算不重复扣。 */
export async function settleDomainStorageUpload(
  domainId: string,
  id: string,
  storageUrl: string,
  executor?: Executor,
) {
  const operation = async (tx: Executor) => {
    // 删除守卫持对象更新锁；先取共享锁再锁域计数，防止删除与结算交错。
    const [object] = await tx.select().from(storageObjects).where(
      eq(storageObjects.storage_url, storageUrl),
    ).for("share");
    const quota = await lockQuota(domainId, tx);
    const [upload] = await tx.select().from(domainStorageUploads).where(
      and(
        eq(domainStorageUploads.id, id),
        eq(domainStorageUploads.domain_id, domainId),
      ),
    );
    if (upload?.state === "settled") {
      if (upload.storage_url !== storageUrl) {
        throw new ConflictError(
          "上传结算对象不一致",
          "STORAGE_RESERVATION_CONFLICT",
        );
      }
      return upload;
    }
    if (!upload || upload.state !== "reserved") {
      throw new ConflictError("上传预约已失效", "STORAGE_RESERVATION_EXPIRED");
    }
    if (!object || object.state !== "ready" || object.byte_size === null) {
      throw new ConflictError(
        "上传对象尚未登记可用大小",
        "STORAGE_OBJECT_NOT_READY",
      );
    }
    if (upload.storage_url !== null && upload.storage_url !== storageUrl) {
      throw new ConflictError(
        "上传结算对象不一致",
        "STORAGE_RESERVATION_CONFLICT",
      );
    }
    const [existing] = await tx.select().from(domainStorageObjects).where(
      and(
        eq(domainStorageObjects.domain_id, domainId),
        eq(domainStorageObjects.storage_url, storageUrl),
      ),
    );
    const added = existing ? 0 : object.byte_size;
    // 已受理预约可以完成；只有超出原预留的实际字节再查当前上限。
    capacity(
      quota.used,
      quota.reserved,
      Math.max(0, added - upload.byte_size),
      quota.limit,
    );
    if (!existing) {
      await tx.insert(domainStorageObjects).values({
        domain_id: domainId,
        storage_url: storageUrl,
        byte_size: object.byte_size,
        created_at: new Date().toISOString(),
      });
    }
    await updateCounter(
      domainId,
      tx,
      quota.used + added,
      quota.reserved - upload.byte_size,
    );
    const [settled] = await tx.update(domainStorageUploads).set({
      state: "settled",
      storage_url: storageUrl,
      finished_at: new Date().toISOString(),
    }).where(eq(domainStorageUploads.id, id)).returning();
    return settled;
  };
  return executor
    ? await operation(executor)
    : await getDb().transaction(operation);
}

/** 失败和取消释放预约；重复释放或已完成预约不更改实际占用。 */
export async function releaseDomainStorageUpload(domainId: string, id: string) {
  return await getDb().transaction(async (tx) => {
    const quota = await lockQuota(domainId, tx);
    const [upload] = await tx.select().from(domainStorageUploads).where(
      and(
        eq(domainStorageUploads.id, id),
        eq(domainStorageUploads.domain_id, domainId),
      ),
    );
    if (!upload || upload.state !== "reserved") return;
    await updateCounter(
      domainId,
      tx,
      quota.used,
      quota.reserved - upload.byte_size,
    );
    await tx.update(domainStorageUploads).set({
      state: "released",
      finished_at: new Date().toISOString(),
    }).where(eq(domainStorageUploads.id, id));
  });
}

/** 引用守卫确认物理删除后，由存储模块在同一事务释放各所属域实际占用。 */
export async function releaseDomainStorageObject(
  storageUrl: string,
  tx: Executor,
) {
  const rows = await tx.select().from(domainStorageObjects).where(
    eq(domainStorageObjects.storage_url, storageUrl),
  ).orderBy(domainStorageObjects.domain_id);
  for (const row of rows) {
    const quota = await lockQuota(row.domain_id, tx);
    const deleted = await tx.delete(domainStorageObjects).where(
      and(
        eq(domainStorageObjects.domain_id, row.domain_id),
        eq(domainStorageObjects.storage_url, storageUrl),
      ),
    ).returning();
    if (deleted.length) {
      await updateCounter(
        row.domain_id,
        tx,
        quota.used - row.byte_size,
        quota.reserved,
      );
    }
  }
}

/** 运维核对计数与持久归属；不把源题的共享引用字节算入目标域。 */
export async function getDomainStorageUsage(domainId: string) {
  const rows = await getDb().execute(sql`SELECT
    COALESCE((SELECT sum(byte_size) FROM domain_storage_objects WHERE domain_id=${domainId}),0)::bigint AS used,
    COALESCE((SELECT sum(byte_size) FROM domain_storage_uploads WHERE domain_id=${domainId} AND state='reserved' AND (storage_url IS NOT NULL OR expires_at>${
    new Date().toISOString()
  })),0)::bigint AS reserved`);
  const [row] = unwrapRows<
    { used: number | string; reserved: number | string }
  >(rows as never);
  return { used: Number(row.used), reserved: Number(row.reserved) };
}

/** 可信存储上传链判断同域已保留对象；内容复用不再预占相同字节。 */
export async function getDomainOwnedStorageBytes(
  domainId: string,
  storageUrl: string,
) {
  const [row] = await getDb().select({ bytes: domainStorageObjects.byte_size })
    .from(domainStorageObjects)
    .innerJoin(
      storageObjects,
      eq(storageObjects.storage_url, domainStorageObjects.storage_url),
    )
    .where(
      and(
        eq(domainStorageObjects.domain_id, domainId),
        eq(domainStorageObjects.storage_url, storageUrl),
        eq(storageObjects.state, "ready"),
      ),
    );
  return row?.bytes ?? null;
}

/** 流式上传拿到对象定位后，在绑定提交前持久记录，以便崩溃后核对。 */
export async function attachDomainStorageUpload(
  domainId: string,
  id: string,
  storageUrl: string,
  executor: Executor,
) {
  await executor.select().from(storageObjects).where(
    eq(storageObjects.storage_url, storageUrl),
  ).for("share");
  await lockQuota(domainId, executor);
  const [updated] = await executor.update(domainStorageUploads).set({
    storage_url: storageUrl,
  }).where(and(
    eq(domainStorageUploads.id, id),
    eq(domainStorageUploads.domain_id, domainId),
    eq(domainStorageUploads.state, "reserved"),
    sql`(${domainStorageUploads.storage_url} IS NULL OR ${domainStorageUploads.storage_url}=${storageUrl})`,
  )).returning();
  if (!updated) {
    throw new ConflictError("上传预约已失效", "STORAGE_RESERVATION_EXPIRED");
  }
  return updated;
}

/** 运维消费者按有限批次核对带物理定位的崩溃遗留预约。 */
export async function listExpiredDomainStorageUploads(limit = 100) {
  return await getDb().select().from(domainStorageUploads).where(
    sql`${domainStorageUploads.state}='reserved' AND ${domainStorageUploads.storage_url} IS NOT NULL AND ${domainStorageUploads.expires_at}<=${
      new Date().toISOString()
    }`,
  ).orderBy(domainStorageUploads.expires_at, domainStorageUploads.id).limit(
    limit,
  );
}

/** 源对象的大小核实候选；只查真实所属域，不把共享绑定当作存储归属。 */
export async function listDomainStorageBaselineObjects(limit = 100) {
  const result = await getDb().execute(sql`SELECT DISTINCT r.storage_url FROM (
    SELECT storage_url FROM problem_draft_objects
    UNION SELECT storage_url FROM problem_version_objects
    UNION SELECT artifact_storage_url FROM submissions WHERE artifact_storage_url IS NOT NULL
  ) r LEFT JOIN storage_objects o ON o.storage_url=r.storage_url
  WHERE o.storage_url IS NULL OR (o.byte_size IS NULL AND o.state<>'deleted')
  ORDER BY r.storage_url LIMIT ${limit}`);
  return unwrapRows<{ storage_url: string }>(result as never);
}

/** 存量物理大小核实后刷新计量；过期未定位预约也在这里回收。 */
export async function reconcileDomainStorageCounters(domainId: string) {
  return await getDb().transaction(async (tx) => {
    const quota = await lockQuota(domainId, tx);
    return { used: quota.used, reserved: quota.reserved };
  });
}

/** 只挑需要初始化或校准的域，每次有限批次，已完成域不反复阻塞后续域。 */
export async function listDomainStorageReconciliationDomains(limit = 100) {
  const result = await getDb().execute(sql`SELECT DISTINCT d.id FROM domains d
    LEFT JOIN domain_resource_counters c ON c.domain_id=d.id AND c.resource='storage_bytes'
    WHERE EXISTS (SELECT 1 FROM (
      SELECT p.domain_id,o.storage_url FROM problem_draft_objects o JOIN problems p ON p.id=o.problem_id
      UNION SELECT p.domain_id,o.storage_url FROM problem_version_objects o JOIN problem_versions v ON v.id=o.version_id JOIN problems p ON p.id=v.problem_id
      UNION SELECT domain_id,artifact_storage_url FROM submissions WHERE artifact_storage_url IS NOT NULL
    ) r JOIN storage_objects o ON o.storage_url=r.storage_url
    LEFT JOIN domain_storage_objects owner ON owner.domain_id=r.domain_id AND owner.storage_url=r.storage_url
    WHERE r.domain_id=d.id AND owner.storage_url IS NULL AND o.byte_size IS NOT NULL AND o.state<>'deleted')
    OR COALESCE(c.used,0)<>(SELECT COALESCE(sum(byte_size),0) FROM domain_storage_objects WHERE domain_id=d.id)
    OR EXISTS (SELECT 1 FROM domain_storage_uploads u WHERE u.domain_id=d.id AND u.state='reserved' AND u.storage_url IS NULL AND u.expires_at<=${
    new Date().toISOString()
  })
    ORDER BY d.id LIMIT ${limit}`);
  return unwrapRows<{ id: string }>(result as never);
}
