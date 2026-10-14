/**
 * 存储对象登记与删除互斥（Handbook §2.5）。
 *
 * 四条不可协商的规则：
 * 1. **新引用不能绑定 `deleting` / `deleted` 对象**——绑定前必须
 *    `assertStorageObjectBindable()`。
 * 2. **删除必须锁登记行、检查全部引用与在途上传预约，再进入 `deleting`**——不能先删
 *    物理对象再补记录（本地上传是内容寻址，删掉的对象可能仍被其他记录共享）。
 * 3. **物理上传之前必须先写上传预约**（`reserveStorageObjectUpload()`，与登记行锁
 *    同一事务），上传成功登记 ready 时消费它——否则"删除在途 + 并发重传同一内容"
 *    会留下 `state = ready` 而物理文件已被删除的对象（2026-10-11 复审问题 1）。
 * 4. **流式上传（`putStream`）无法在上传前预测内容哈希**，改用
 *    `registerStreamedStorageObject()` 在登记行锁事务内 `stat()` 复核后登记：
 *    物理存在才置 `ready`，缺失则拒绝绑定——否则"删除后重传同一内容"会永久卡在
 *    `deleted`（2026-10-11 复审问题 7）。
 * 5. **上传补偿不得直接调用 `storage.delete()`**——统一走
 *    `deleteStorageObject()`，它在有引用时拒绝物理删除并返回 `referenced`。
 *
 * 状态机：`unknown`（存量登记，未核实）→ `ready` ↔ `missing`；
 * `ready`/`missing` → `deleting` → `deleted`。
 *
 * 上传协议（两条路径，按上传前是否已知内容哈希选择）：
 * ```ts
 * // A. 内容已知（put）：预约 → 物理上传 → 消费预约登记 ready
 * const reservation = await reserveStorageObjectUpload({ storageUrl });
 * const url = await storage.put(key, bytes);
 * await registerReadyStorageObject({ storageUrl: url, reservationId: reservation.reservation_id });
 *
 * // B. 流式（putStream）：物理上传 → 在绑定引用的同一事务内 stat 复核后登记
 * const url = await storage.putStream(key, stream, contentType);
 * await db.transaction(async (tx) => {
 *   await registerStreamedStorageObject({ storageUrl: url }, tx); // 锁内 stat，缺失即抛错
 *   await assertStorageObjectBindable(url, tx);
 *   // …插入业务引用
 * });
 * ```
 * `registerReadyStorageObject()` 只有在**持有本人未过期预约**时才允许把
 * `deleting` / `deleted` 恢复为 `ready`：仅凭"此前上传成功"无条件恢复会在删除已经
 * 物理删掉文件后写出一个 `ready` 的幽灵记录。流式路径没有预约，其等价的"新鲜性
 * 证明"是**持锁当下的 stat 事实**——删除方需要同一把登记行锁，因此它无法在
 * "stat 确认存在"与"登记 ready"之间物理删除。
 */

import { and, eq, gt, lte, sql } from "drizzle-orm";
import { AppError } from "../../../../shared/base/errors.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import type { Executor, RootDb } from "../../../../shared/db/executor.ts";
import {
  problemDraftObjects,
  problemVersionObjects,
  storageObjectReservations,
  storageObjects,
  submissions,
} from "../../../../shared/db/schema.ts";
import type { StorageObjectState } from "../../../../shared/versioning/types.ts";
import { getStorageProvider } from "./factory.ts";
import { parseStorageUrl, sha256Hex } from "./types.ts";
import {
  getDomainOwnedStorageBytes,
  releaseDomainStorageObject,
  releaseDomainStorageUpload,
  reserveDomainStorageUpload,
  settleDomainStorageUpload,
} from "../../../workspace/index.ts";

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

/** 上传预约默认有效期（15 分钟）：够大文件上传，crash 残留又能自动失效。 */
export const STORAGE_UPLOAD_RESERVATION_TTL_MS = 15 * 60 * 1000;

/** 在途上传预约：物理上传**之前**写入，上传成功登记 `ready` 时删除。 */
export interface StorageUploadReservation {
  reservation_id: string;
  storage_url: string;
  reserved_at: string;
  /** ISO 8601 UTC；`expires_at <= now` 视为无效（crash 残留不得永久阻塞删除）。 */
  expires_at: string;
}

/** 删除被在途上传预约拒绝：可重试错误（HTTP 409）。 */
export class StorageUploadInFlightError extends AppError {
  constructor() {
    super(
      "存储对象正在上传中，删除被拒绝（可重试）",
      409,
      "STORAGE_OBJECT_UPLOAD_IN_FLIGHT",
    );
    this.name = "StorageUploadInFlightError";
  }
}

/**
 * 缺少本次上传自己的未过期预约，不得把 `deleting` / `deleted` 恢复为 `ready`。
 *
 * 仅凭"此前某次上传成功"就恢复，会在删除已经物理删掉文件之后写出 `ready` 的幽灵
 * 记录——这正是 2026-10-11 复审问题 1 的根因。
 */
export class StorageObjectDeletedError extends AppError {
  constructor(storageUrl: string) {
    super(
      `存储对象已进入删除流程，缺少本次上传的未过期预约，不能登记为 ready：${storageUrl}`,
      409,
      "STORAGE_OBJECT_DELETED",
    );
    this.name = "StorageObjectDeletedError";
  }
}

/**
 * 流式上传复核时后端**明确报告**物理对象不存在：拒绝登记与绑定（可重试）。
 *
 * 只在 `stat()` 返回 `{ exists: false }` 时抛出——`stat()` 抛错（网络/403）表示
 * "无法确认"，必须原样上抛，绝不能当成不存在而拒绝一次真实上传。
 */
export class StorageObjectMissingError extends AppError {
  constructor(storageUrl: string) {
    super(
      `存储对象物理不存在，拒绝登记与绑定（请重新上传）：${storageUrl}`,
      409,
      "STORAGE_OBJECT_MISSING",
    );
    this.name = "StorageObjectMissingError";
  }
}

/** 从 `noj-storage://` URL 读取内嵌 checksum（解析失败返回 null）。 */
function checksumFromStorageUrl(storageUrl: string): string | null {
  try {
    return parseStorageUrl(storageUrl).checksumSha256 ?? null;
  } catch {
    return null;
  }
}

/**
 * 登记行锁：先 upsert 保证行存在（`SELECT ... FOR UPDATE` 锁不住不存在的行），
 * 再取更新锁。
 *
 * 上传预约、登记 `ready`、删除守卫三者都先调用本函数，因此三者严格串行：删除的
 * "引用检查 + 物理删除"期间不可能插入新预约；上传的"预约 + 登记"期间也不可能被
 * 删除穿透。
 */
async function lockStorageObjectRow(
  tx: StorageExecutor,
  storageUrl: string,
): Promise<StorageObjectRecord | undefined> {
  await tx.insert(storageObjects).values({
    storage_url: storageUrl,
    state: "unknown",
    created_at: new Date().toISOString(),
  }).onConflictDoNothing();
  const rows = await tx.select().from(storageObjects).where(
    eq(storageObjects.storage_url, storageUrl),
  ).for("update");
  return rows[0] as StorageObjectRecord | undefined;
}

/**
 * 写入上传预约（**必须在物理上传之前调用**）。
 *
 * 与登记行锁同一事务：写入成功后提交，锁释放，但预约行本身持续证明"有上传在途"，
 * 直到 {@link registerReadyStorageObject} 消费它或（进程崩溃后）自然过期。
 *
 * 预约写入与删除守卫争用同一把登记行锁，所以只要预约先提交，删除就不可能穿透
 * 物理上传窗口；即使删除先拿到锁，上传方的预约也要排队到删除提交之后才写入，
 * 于是物理上传必然发生在删除之后（而不是之前）。
 */
export async function reserveStorageObjectUpload(
  input: { storageUrl: string; ttlMs?: number },
  executor?: StorageExecutor,
): Promise<StorageUploadReservation> {
  const db = (executor ?? getDb()) as RootDb;
  const ttlMs = input.ttlMs ?? STORAGE_UPLOAD_RESERVATION_TTL_MS;
  return await db.transaction(async (tx) => {
    await lockStorageObjectRow(tx, input.storageUrl);
    const reservedAt = new Date();
    const reservation: StorageUploadReservation = {
      reservation_id: crypto.randomUUID(),
      storage_url: input.storageUrl,
      reserved_at: reservedAt.toISOString(),
      expires_at: new Date(reservedAt.getTime() + ttlMs).toISOString(),
    };
    await tx.insert(storageObjectReservations).values(reservation);
    return reservation;
  });
}

/**
 * 上传前预约（**内容已知**路径的便捷入口）。
 *
 * 先算内容 SHA-256 → 用 provider 的 `urlForUpload()` 预测本次 `put()` 将返回的
 * 存储 URL → 写 reservation。调用方拿到 `storageUrl` 后执行物理上传，再用它与
 * `reservation.reservation_id` 调用 {@link registerReadyStorageObject}。
 *
 * 物理上传失败时用 {@link releaseStorageObjectUploadReservation} 释放预约；
 * 已上传但后续事务失败的补偿走 {@link compensateUploadedObject}。
 */
export async function reserveStorageObjectUploadForContent(
  input: {
    key: string;
    bytes: Uint8Array;
    contentType?: string;
    ttlMs?: number;
    /** 已知的内容 SHA-256（避免重复计算）；缺省时内部计算。 */
    sha256?: string | null;
  },
  executor?: StorageExecutor,
): Promise<{ storageUrl: string; reservation: StorageUploadReservation }> {
  const storage = await getStorageProvider();
  if (!storage.urlForUpload) {
    throw new Error(
      "当前存储后端不支持上传前 URL 预测，无法在物理上传前写预约",
    );
  }
  const contentSha256 = input.sha256 ?? await sha256Hex(input.bytes);
  const storageUrl = storage.urlForUpload(
    input.key,
    contentSha256,
    input.contentType,
  );
  const reservation = await reserveStorageObjectUpload(
    { storageUrl, ttlMs: input.ttlMs },
    executor,
  );
  return { storageUrl, reservation };
}

/**
 * 带预约的物理上传（**唯一的"上传并登记"入口**）：预约 → `put()` → 登记 `ready`。
 *
 * 顺序不可交换：reservation 必须先于物理上传提交，删除守卫才能在"文件正在被写回"
 * 的窗口里拒绝物理删除（Handbook §2.5、2026-10-11 复审问题 1）。
 *
 * - 物理上传失败：释放自己的预约，不留下阻塞删除的残留；
 * - 上传成功但登记失败：走 {@link compensateUploadedObject}（引用守卫，共享对象
 *   不会被误删）；
 * - 后端返回的 URL 与内容寻址预测不一致：视为契约破坏，同样走补偿后抛错。
 *
 * @returns 登记为 `ready` 的存储 URL
 */
export async function uploadStorageObjectWithReservation(
  input: {
    key: string;
    bytes: Uint8Array;
    contentType?: string;
    /** 已知的内容 SHA-256；缺省时内部计算。 */
    sha256?: string | null;
    ttlMs?: number;
    /** 调用方从已授权源题或提交定位，不读取上传表单中的域 ID。 */
    domainId?: string;
  },
  executor?: StorageExecutor,
): Promise<{ storageUrl: string }> {
  const storage = await getStorageProvider();
  const contentSha256 = input.sha256 ?? await sha256Hex(input.bytes);
  const { storageUrl, reservation } =
    await reserveStorageObjectUploadForContent(
      { ...input, sha256: contentSha256 },
      executor,
    );
  let uploaded = false;
  let domainUpload:
    | Awaited<ReturnType<typeof reserveDomainStorageUpload>>
    | undefined;
  try {
    if (input.domainId) {
      const owned = await getDomainOwnedStorageBytes(
        input.domainId,
        storageUrl,
      );
      domainUpload = await reserveDomainStorageUpload({
        domainId: input.domainId,
        bytes: owned === null ? input.bytes.byteLength : 0,
        storageUrl,
      });
    }
    const putUrl = await storage.put(input.key, input.bytes, input.contentType);
    uploaded = true;
    if (putUrl !== storageUrl) {
      throw new Error(
        `存储后端返回的 URL 与上传前预测不一致（拒绝登记到错误的登记行）：${putUrl} != ${storageUrl}`,
      );
    }
    await registerReadyStorageObject(
      {
        storageUrl,
        sha256: contentSha256,
        byteSize: input.bytes.byteLength,
        reservationId: reservation.reservation_id,
      },
      executor,
    );
    if (domainUpload) {
      await settleDomainStorageUpload(
        domainUpload.domain_id,
        domainUpload.id,
        storageUrl,
      );
    }
    return { storageUrl };
  } catch (error) {
    if (domainUpload) {
      await releaseDomainStorageUpload(domainUpload.domain_id, domainUpload.id);
    }
    if (uploaded) {
      await compensateUploadedObject(
        { storageUrl, reservationId: reservation.reservation_id },
        executor,
      ).catch(() => {});
    } else {
      await releaseStorageObjectUploadReservation(
        reservation.reservation_id,
        executor,
      ).catch(() => {});
    }
    throw error;
  }
}

/**
 * 释放上传预约（物理上传失败或放弃上传时调用）。
 *
 * 只删除本次自己的预约行：其他并发上传的预约不受影响。释放后删除守卫即可正常
 * 推进（对象无引用且无其他预约时）。物理上传本身失败时对象没有新增字节，不需要
 * 走 `deleteStorageObject()`。
 */
export async function releaseStorageObjectUploadReservation(
  reservationId: string,
  executor?: StorageExecutor,
): Promise<void> {
  const db = executor ?? getDb();
  await db.delete(storageObjectReservations).where(
    eq(storageObjectReservations.reservation_id, reservationId),
  );
}

/**
 * 登记一个新上传对象（`state = ready`）。
 *
 * 同 URL 重复登记是幂等的（内容寻址下同一字节内容会得到同一 URL）。调用方必须在
 * **物理上传成功之后**调用本函数，并传入上传前 {@link reserveStorageObjectUpload}
 * 拿到的 `reservationId`。
 *
 * 契约（Handbook §2.5）：
 * - 对象处于 `deleting` / `deleted` 时，**只有**持有本人未过期预约才允许恢复
 *   `ready`——预约证明"物理上传发生在删除之后"，恢复是安全的；否则抛
 *   {@link StorageObjectDeletedError}，绝不写出幽灵 `ready`。
 * - 登记与删除共用同一登记行锁，预约的消费与状态更新在同一事务内完成。
 */
export async function registerReadyStorageObject(
  input: {
    storageUrl: string;
    sha256?: string | null;
    byteSize?: number | null;
    /** {@link reserveStorageObjectUpload} 返回的预约 id。 */
    reservationId?: string;
  },
  executor?: StorageExecutor,
): Promise<void> {
  const db = (executor ?? getDb()) as RootDb;
  await db.transaction(async (tx) => {
    const existing = await lockStorageObjectRow(tx, input.storageUrl);
    if (!existing) return;

    // 消费本人预约：id、URL、未过期三者必须同时匹配，防止拿了别人的预约或过期
    // 预约来"证明"一次并不存在的物理上传。
    const consumed = input.reservationId
      ? await tx.delete(storageObjectReservations).where(
        and(
          eq(
            storageObjectReservations.reservation_id,
            input.reservationId,
          ),
          eq(storageObjectReservations.storage_url, input.storageUrl),
          gt(storageObjectReservations.expires_at, new Date().toISOString()),
        ),
      ).returning({ id: storageObjectReservations.reservation_id })
      : [];

    if (
      (existing.state === "deleting" || existing.state === "deleted") &&
      consumed.length === 0
    ) {
      throw new StorageObjectDeletedError(input.storageUrl);
    }

    await tx.update(storageObjects).set({
      state: "ready",
      sha256: input.sha256 ?? existing.sha256,
      byte_size: input.byteSize ?? existing.byte_size,
    }).where(eq(storageObjects.storage_url, input.storageUrl));
  });
}

/**
 * **流式上传**（`putStream`）完成后的持锁复核登记（2026-10-11 复审问题 7）。
 *
 * 为什么需要独立入口：`putStream` 边写边算 SHA-256，调用方在物理上传完成前拿不到
 * URL/哈希，因此无法先写预约。这条路径的"新鲜性证明"换成**持锁当下的真实
 * `stat()`**：
 *
 * 1. 后端确认存在 → 用服务端元数据（URL 内嵌 checksum + stat 大小）更新登记并置
 *    `ready`。`unknown` / `missing` / `deleted` / `deleting` 都可以恢复——依据是此刻
 *    的物理事实，而不是"此前上传成功过"。
 * 2. 后端明确不存在（`exists: false`）→ **不置 `ready`**，抛
 *    {@link StorageObjectMissingError} 拒绝绑定（调用方重新上传后即可通过）。
 * 3. `stat()` 抛错（网络/403/超时）→ 原样上抛：无法确认就不得改写登记状态。
 *
 * **必须与"插入业务引用"处于同一事务**：本函数只加锁、不提交。删除方需要同一把
 * 登记行锁，所以在"stat 确认存在"与"引用落库"之间它插不进来；而本事务一旦提交，
 * 引用计数非零，删除守卫只会返回 `referenced`。若把本函数放到独立事务，两个提交点
 * 之间就会出现"登记 ready → 无引用 → 被删 → 绑定失败"的窗口。
 *
 * 另外，删除方在本函数持锁期间也不会物理删除对象，因此不需要额外的短租约；
 * 若调用方在 putStream 之后还有长时间外部 IO，可在拿到 URL 后补一个
 * {@link reserveStorageObjectUpload} 短租约以降低"上传白做"的概率（可选优化，
 * 不是正确性前提），但必须保证所有失败路径都
 * {@link releaseStorageObjectUploadReservation}。
 */
export async function registerStreamedStorageObject(
  input: {
    storageUrl: string;
    /** 已知的内容 SHA-256；缺省时优先取 URL 内嵌 checksum。 */
    sha256?: string | null;
    byteSize?: number | null;
  },
  executor?: StorageExecutor,
): Promise<void> {
  const db = (executor ?? getDb()) as RootDb;
  await db.transaction(async (tx) => {
    const existing = await lockStorageObjectRow(tx, input.storageUrl);
    if (!existing) throw new StorageObjectMissingError(input.storageUrl);

    // 持锁后核实物理事实：stat 抛错 = 无法确认 → 原样上抛，不改登记状态。
    const storage = await getStorageProvider();
    const stat = await storage.stat(input.storageUrl);
    if (!stat.exists) {
      throw new StorageObjectMissingError(input.storageUrl);
    }

    await tx.update(storageObjects).set({
      state: "ready",
      sha256: checksumFromStorageUrl(input.storageUrl) ??
        input.sha256 ?? existing.sha256,
      byte_size: stat.sizeBytes ?? input.byteSize ?? existing.byte_size,
    }).where(eq(storageObjects.storage_url, input.storageUrl));
  });
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
  // 插入与加锁都在调用方绑定引用的同一事务里完成。先读后插会与删除争抢，
  // 只读不加锁则允许删除方在检查引用之后移除即将被绑定的对象。
  await db.insert(storageObjects).values({
    storage_url: storageUrl,
    state: "unknown",
    created_at: new Date().toISOString(),
  }).onConflictDoNothing();
  const [record] = await db.select().from(storageObjects).where(
    eq(storageObjects.storage_url, storageUrl),
  ).for("update");
  if (record.state === "deleting" || record.state === "deleted") {
    throw new Error(`存储对象已进入删除流程，不能建立新引用：${storageUrl}`);
  }
}

/**
 * 用后端真实元数据核实对象，并升级登记状态。
 *
 * 返回核实后的状态：`ready`（存在）/ `missing`（后端**明确**不存在）。
 * 只在状态不是 `deleting` / `deleted` 时更新，避免与删除流程竞争。
 *
 * `stat()` 抛错（网络超时、403、S3 5xx）表示"无法确认"，**不能**当成不存在：
 * 后端实现只对明确的 NotFound/404 返回 `{ exists: false }`，其余异常在这里
 * 原样上抛，登记状态保持原值——否则一次网络抖动就会把真实存在的对象永久写成
 * `missing`（Handbook §2.5，tracking #13）。
 */
export async function verifyStorageObject(
  storageUrl: string,
  executor?: StorageExecutor,
): Promise<StorageObjectState> {
  const db = executor ?? getDb();
  const storage = await getStorageProvider();
  const stat = await storage.stat(storageUrl);
  const nextState: StorageObjectState = stat.exists ? "ready" : "missing";
  await db.update(storageObjects).set({
    state: nextState,
    byte_size: stat.exists ? stat.sizeBytes ?? null : 0,
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
 * 引用守卫删除：锁定登记行 → 检查全部引用 → 检查在途上传预约 → 进入 `deleting` →
 * 物理删除 → `deleted`，**全过程在同一个持有登记行锁的事务内**。
 *
 * 有引用时**不删除**并返回 `referenced`，调用方据此保留对象（上传补偿路径必须
 * 接受这个结果，而不是绕过守卫直接删除）。
 *
 * 有**未过期上传预约**时抛 {@link StorageUploadInFlightError}（409，可重试）：
 * 此刻删掉物理文件，上传方随后就会把对象登记成 `ready`，得到 `ready` + 物理缺失的
 * 幽灵记录（2026-10-11 复审问题 1）。过期预约代表 crash 残留，先清理再判定，
 * 不得永久阻塞删除。
 *
 * 为什么物理删除也必须在锁内（tracking #12/#14）：
 * - 若先提交 `deleting` 再在事务外物理删除，"检查无引用 → 新引用建立 → 对象被删"
 *   的窗口就重新出现；把删除放在锁内后，绑定方（`assertStorageObjectBindable`）
 *   会阻塞到本事务提交，然后看到 `deleted` 而被拒绝。
 * - 崩溃或后端报错时整个事务回滚，状态回到删除前，**不会留下卡死的 `deleting`**；
 *   反之，能拿到行锁却读到 `deleting`，说明上一次删除已回滚/崩溃，本次直接续做。
 */
export async function deleteStorageObject(
  storageUrl: string,
  executor?: StorageExecutor,
): Promise<StorageDeleteOutcome> {
  const db = (executor ?? getDb()) as RootDb;
  return await db.transaction(async (tx) => {
    const existing = await lockStorageObjectRow(tx, storageUrl);
    const nowIso = new Date().toISOString();

    // 崩溃遗留的过期预约立即清掉：crash 不得永久阻塞删除。
    await tx.delete(storageObjectReservations).where(
      and(
        eq(storageObjectReservations.storage_url, storageUrl),
        lte(storageObjectReservations.expires_at, nowIso),
      ),
    );

    if (existing?.state === "deleted") {
      // 已删除：不再触碰物理文件（在途重传可能刚写回同一内容，交给它登记）。
      await releaseDomainStorageObject(storageUrl, tx);
      return { outcome: "deleted" } as const;
    }

    const references = await collectStorageReferences(storageUrl, tx);
    if (references.total > 0) {
      return { outcome: "referenced", references } as const;
    }

    const [inFlight] = await tx.select({ count: sql<number>`count(*)::int` })
      .from(storageObjectReservations)
      .where(
        and(
          eq(storageObjectReservations.storage_url, storageUrl),
          gt(storageObjectReservations.expires_at, nowIso),
        ),
      );
    if ((inFlight?.count ?? 0) > 0) {
      throw new StorageUploadInFlightError();
    }

    // 标记与物理删除同事务：新引用必须等到本事务提交后看到 `deleted` 再被拒绝。
    await tx.update(storageObjects).set({ state: "deleting" }).where(
      eq(storageObjects.storage_url, storageUrl),
    );

    // 后端不可达时抛错 → 事务回滚（状态不变），绝不谎称 deleted。
    const storage = await getStorageProvider();
    const stat = await storage.stat(storageUrl);
    if (stat.exists) {
      await storage.delete(storageUrl);
    }
    await tx.update(storageObjects).set({ state: "deleted" }).where(
      eq(storageObjects.storage_url, storageUrl),
    );
    await releaseDomainStorageObject(storageUrl, tx);
    return stat.exists
      ? ({ outcome: "deleted" } as const)
      : ({ outcome: "missing" } as const);
  });
}

/**
 * 上传补偿：登记并尽力删除，**有引用时保留对象**。
 *
 * 用于「上传成功但后续事务失败」的清理路径。内容寻址下同一字节内容可能已被
 * 其他记录引用，直接 `storage.delete()` 会把别人的文件删掉。
 *
 * 对象已在 `deleting` / `deleted` 时**不恢复** `ready`（那会制造幽灵 `ready`）：
 * 直接交给删除守卫判定——它要么因引用而在字节层面保留对象，要么返回 `deleted`；
 * 若此时还有别人的在途预约则抛 409，由调用方决定重试。此时调用方自己的预约会被
 * 释放，避免残留阻塞后续删除。
 */
export async function compensateUploadedObject(
  input: {
    storageUrl: string;
    sha256?: string | null;
    byteSize?: number | null;
    /** 本次上传自己的预约 id；上传失败时用于释放预约。 */
    reservationId?: string;
  },
  executor?: StorageExecutor,
): Promise<StorageDeleteOutcome> {
  const db = executor ?? getDb();
  const record = await getStorageObject(input.storageUrl, db);
  if (!record || (record.state !== "deleting" && record.state !== "deleted")) {
    await registerReadyStorageObject(input, db);
  } else if (input.reservationId) {
    await releaseStorageObjectUploadReservation(input.reservationId, db);
  }
  return await deleteStorageObject(input.storageUrl, db);
}
