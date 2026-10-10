/**
 * 存储对象登记与删除互斥（Handbook §2.5）。
 *
 * 三条不可协商的规则：
 * 1. **新引用不能绑定 `deleting` / `deleted` 对象**——绑定前必须
 *    `assertStorageObjectBindable()`。
 * 2. **删除必须锁登记行、检查全部引用，再进入 `deleting`**——不能先删物理对象
 *    再补记录（本地上传是内容寻址，删掉的对象可能仍被其他记录共享）。
 * 3. **上传补偿不得直接调用 `storage.delete()`**——统一走
 *    `deleteStorageObject()`，它在有引用时拒绝物理删除并返回 `referenced`。
 *
 * 状态机：`unknown`（存量登记，未核实）→ `ready` ↔ `missing`；
 * `ready`/`missing` → `deleting` → `deleted`。
 */

import { and, eq, or, sql } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import type { Executor, RootDb } from "../../../../shared/db/executor.ts";
import {
  problemDraftObjects,
  problemVersionObjects,
  storageObjects,
  submissions,
} from "../../../../shared/db/schema.ts";
import type { StorageObjectState } from "../../../../shared/versioning/types.ts";
import { unwrapRows } from "../../../../shared/base/sql-rows.ts";
import { getStorageProvider } from "./factory.ts";

/** 登记行读模型。 */
export interface StorageObjectRecord {
  storage_url: string;
  sha256: string | null;
  byte_size: number | null;
  state: StorageObjectState;
  created_at: string;
}

/** 引用检查结果：任一计数非零即禁止物理删除。 */
export interface StorageReferenceReport {
  draft_refs: number;
  version_refs: number;
  artifact_submissions: number;
  self_test_refs: number;
  total: number;
}

/** 数据库或事务句柄（见 `shared/db/executor.ts`）。 */
type StorageExecutor = Executor;

/**
 * 登记一个新上传对象（`state = ready`）。
 *
 * 同 URL 重复登记是幂等的（内容寻址下同一字节内容会得到同一 URL），
 * 已存在的行只补空字段，**不回退状态**（`deleted` 不会被改回 `ready`）。
 */
export async function registerReadyStorageObject(
  input: {
    storageUrl: string;
    sha256?: string | null;
    byteSize?: number | null;
  },
  executor?: StorageExecutor,
): Promise<void> {
  await registerStorageObject(
    {
      storageUrl: input.storageUrl,
      sha256: input.sha256 ?? null,
      byteSize: input.byteSize ?? null,
      state: "ready",
    },
    executor,
  );
}

/**
 * 登记一个存量对象（`state = unknown`）：首次预检或使用时会核实并升级为
 * `ready` / `missing`。存量迁移只能诚实标注未知，不能假设对象存在。
 */
export async function registerLegacyStorageObject(
  storageUrl: string,
  executor?: StorageExecutor,
): Promise<void> {
  await registerStorageObject(
    { storageUrl, sha256: null, byteSize: null, state: "unknown" },
    executor,
  );
}

/** 登记（upsert）一个存储对象；不改变已登记对象的既有状态。 */
export async function registerStorageObject(
  input: {
    storageUrl: string;
    sha256: string | null;
    byteSize: number | null;
    state: StorageObjectState;
  },
  executor?: StorageExecutor,
): Promise<void> {
  const db = executor ?? getDb();
  await db.insert(storageObjects).values({
    storage_url: input.storageUrl,
    sha256: input.sha256,
    byte_size: input.byteSize,
    state: input.state,
    created_at: new Date().toISOString(),
  }).onConflictDoUpdate({
    target: storageObjects.storage_url,
    set: {
      sha256: sql`COALESCE(${storageObjects.sha256}, excluded.sha256)`,
      byte_size: sql`COALESCE(${storageObjects.byte_size}, excluded.byte_size)`,
    },
  });
}

/** 读取登记行；不存在返回 null。 */
export async function getStorageObject(
  storageUrl: string,
  executor?: StorageExecutor,
): Promise<StorageObjectRecord | null> {
  const db = executor ?? getDb();
  const rows = await db.select().from(storageObjects).where(
    eq(storageObjects.storage_url, storageUrl),
  ).limit(1);
  return (rows[0] as StorageObjectRecord | undefined) ?? null;
}

/**
 * 断言对象可以绑定为业务引用。
 *
 * `deleting` / `deleted` 状态一律拒绝：前者正在物理删除，后者已经删除。
 * 未登记对象先补登记为 `unknown`（存量对象路径），随后仍允许绑定——
 * 存量的支持包引用必须能继续被历史版本使用。
 */
export async function assertStorageObjectBindable(
  storageUrl: string,
  executor?: StorageExecutor,
): Promise<void> {
  const db = executor ?? getDb();
  const record = await getStorageObject(storageUrl, db);
  if (!record) {
    await registerLegacyStorageObject(storageUrl, db);
    return;
  }
  if (record.state === "deleting" || record.state === "deleted") {
    throw new Error(`存储对象已进入删除流程，不能建立新引用：${storageUrl}`);
  }
}

/**
 * 用后端真实元数据核实对象，并升级登记状态。
 *
 * 返回核实后的状态：`ready`（存在）/ `missing`（后端不存在）。
 * 只在状态不是 `deleting` 时更新，避免与删除流程竞争。
 */
export async function verifyStorageObject(
  storageUrl: string,
  executor?: StorageExecutor,
): Promise<StorageObjectState> {
  const db = executor ?? getDb();
  const storage = await getStorageProvider();
  let stat: { exists: boolean; sizeBytes: number | null };
  try {
    stat = await storage.stat(storageUrl);
  } catch {
    return "missing";
  }
  const nextState: StorageObjectState = stat.exists ? "ready" : "missing";
  await db.update(storageObjects).set({
    state: nextState,
    byte_size: stat.sizeBytes ?? null,
  }).where(
    and(
      eq(storageObjects.storage_url, storageUrl),
      sql`${storageObjects.state} <> 'deleting'`,
      sql`${storageObjects.state} <> 'deleted'`,
    ),
  );
  return nextState;
}

/** 统计某对象仍被哪些业务引用。 */
export async function collectStorageReferences(
  storageUrl: string,
  executor?: StorageExecutor,
): Promise<StorageReferenceReport> {
  const db = executor ?? getDb();
  const [draft] = await db.select({ count: sql<number>`count(*)::int` })
    .from(problemDraftObjects)
    .where(eq(problemDraftObjects.storage_url, storageUrl));
  const [version] = await db.select({ count: sql<number>`count(*)::int` })
    .from(problemVersionObjects)
    .where(eq(problemVersionObjects.storage_url, storageUrl));
  const [artifact] = await db.select({ count: sql<number>`count(*)::int` })
    .from(submissions)
    .where(eq(submissions.artifact_storage_url, storageUrl));
  const report: StorageReferenceReport = {
    draft_refs: draft?.count ?? 0,
    version_refs: version?.count ?? 0,
    artifact_submissions: artifact?.count ?? 0,
    self_test_refs: 0,
    total: 0,
  };
  report.total = report.draft_refs + report.version_refs +
    report.artifact_submissions + report.self_test_refs;
  return report;
}

/** 删除结果：`deleted` 已物理删除 / `referenced` 仍被引用 / `missing` 对象本就不存在。 */
export type StorageDeleteOutcome =
  | { outcome: "deleted" }
  | { outcome: "referenced"; references: StorageReferenceReport }
  | { outcome: "missing" };

/**
 * 引用守卫删除：锁定登记行 → 检查引用 → 进入 `deleting` → 物理删除 → `deleted`。
 *
 * 有引用时**不删除**并返回 `referenced`，调用方据此保留对象（上传补偿路径必须
 * 接受这个结果，而不是绕过守卫直接删除）。
 */
export async function deleteStorageObject(
  storageUrl: string,
  executor?: StorageExecutor,
): Promise<StorageDeleteOutcome> {
  const db = (executor ?? getDb()) as RootDb;
  await db.transaction(async (tx) => {
    // 锁定登记行（无行则按存量对象补登记，再参与后续守卫）
    const locked = await tx.execute(
      sql`SELECT storage_url, state FROM storage_objects WHERE storage_url = ${storageUrl} FOR UPDATE`,
    );
    if (unwrapRows(locked as unknown[]).length === 0) {
      await registerLegacyStorageObject(storageUrl, tx);
    }
  });

  const existing = await getStorageObject(storageUrl, db);
  if (existing?.state === "deleted") return { outcome: "deleted" };

  const references = await collectStorageReferences(storageUrl, db);
  if (references.total > 0) return { outcome: "referenced", references };

  const marked = await db.update(storageObjects).set({ state: "deleting" })
    .where(
      and(
        eq(storageObjects.storage_url, storageUrl),
        or(
          eq(storageObjects.state, "ready"),
          eq(storageObjects.state, "unknown"),
          eq(storageObjects.state, "missing"),
        ),
      ),
    ).returning({ storage_url: storageObjects.storage_url });
  if (marked.length === 0) {
    // 并发删除已在进行或已完成
    const current = await getStorageObject(storageUrl, db);
    return current?.state === "deleted"
      ? { outcome: "deleted" }
      : { outcome: "referenced", references };
  }

  const storage = await getStorageProvider();
  const stat = await storage.stat(storageUrl).catch(() => ({
    exists: false,
    sizeBytes: null,
  }));
  if (stat.exists) {
    try {
      await storage.delete(storageUrl);
    } catch (error) {
      // 删除失败必须回退状态，否则对象永远卡在 deleting
      await db.update(storageObjects).set({ state: "ready" }).where(
        eq(storageObjects.storage_url, storageUrl),
      );
      throw error;
    }
  }
  await db.update(storageObjects).set({ state: "deleted" }).where(
    eq(storageObjects.storage_url, storageUrl),
  );
  return stat.exists ? { outcome: "deleted" } : { outcome: "missing" };
}

/**
 * 上传补偿：登记并尽力删除，**有引用时保留对象**。
 *
 * 用于「上传成功但后续事务失败」的清理路径。内容寻址下同一字节内容可能已被
 * 其他记录引用，直接 `storage.delete()` 会把别人的文件删掉。
 */
export async function compensateUploadedObject(
  input: {
    storageUrl: string;
    sha256?: string | null;
    byteSize?: number | null;
  },
  executor?: StorageExecutor,
): Promise<StorageDeleteOutcome> {
  const db = executor ?? getDb();
  await registerReadyStorageObject(input, db);
  return await deleteStorageObject(input.storageUrl, db);
}
