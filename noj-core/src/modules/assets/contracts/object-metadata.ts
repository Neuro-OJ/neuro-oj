/**
 * assets 对外的对象元数据窄事务合同。
 *
 * `storage_objects` 由 assets 持有；题目发布等业务流程只能在**自己的外层事务**
 * 内通过这里补齐/校正登记元数据，不能直接更新 assets 拥有的表。
 *
 * 设计约束：
 * - 第一个参数是真实 `DbTx`：不自开根事务、不读默认连接；
 * - 只写 `storage_objects` 的元数据列，不改业务引用；
 * - **不把 provider 不可达解释为对象不存在**：本合同只依据数据库登记事实判断，
 *   从不调用存储后端。物理存在性由发布预检/上传流程单独核实。
 */
import { eq } from "drizzle-orm";
import { AppError } from "../../../shared/base/errors.ts";
import type { DbTx } from "../../../shared/db/executor.ts";
import { storageObjects } from "../../../shared/db/schema.ts";

/** 与 `storage_objects.state` 一致：这两个状态已经进入不可逆删除流程。 */
const DELETED_STATES = new Set(["deleting", "deleted"]);

/**
 * 校验登记对象与状态后更新内容摘要（`sha256`）。
 *
 * 行为固定为：
 * 1. 行不存在 → 409 `STORAGE_OBJECT_NOT_REGISTERED`：登记缺失说明调用方遗漏了
 *    登记步骤，必须显式失败，而不能悄悄插入一行冒充"对象已存在"；
 * 2. 对象处于 `deleting` / `deleted` → 409 `STORAGE_OBJECT_DELETED`：删除流程
 *    已经接管该行，补写摘要会产生幽灵引用；
 * 3. 其他状态（`unknown` / `missing` / `ready`）允许写入摘要，`byte_size`
 *    与 `state` 原样保留——本合同只负责摘要这一列。
 *
 * 摘要相同则跳过写入（幂等）。返回写入后的摘要，便于调用方在审计中引用同一事实。
 *
 * @throws {AppError} 400 摘要为空；409 未登记或已进入删除流程
 */
export async function updateStorageObjectSha256Tx(
  tx: DbTx,
  storageUrl: string,
  sha256: string,
): Promise<string> {
  if (typeof storageUrl !== "string" || storageUrl.trim() === "") {
    throw new AppError("存储对象定位不能为空", 400, "STORAGE_URL_REQUIRED");
  }
  const normalized = sha256.trim();
  if (normalized === "") {
    throw new AppError("内容摘要不能为空", 400, "INVALID_SHA256");
  }
  const [record] = await tx.select({
    state: storageObjects.state,
    sha256: storageObjects.sha256,
  }).from(storageObjects).where(
    eq(storageObjects.storage_url, storageUrl),
  ).for("update");
  if (!record) {
    throw new AppError(
      `存储对象未登记：${storageUrl}`,
      409,
      "STORAGE_OBJECT_NOT_REGISTERED",
    );
  }
  if (DELETED_STATES.has(record.state)) {
    throw new AppError(
      `存储对象已进入删除流程，不能补齐摘要：${storageUrl}`,
      409,
      "STORAGE_OBJECT_DELETED",
    );
  }
  if (record.sha256 === normalized) return normalized;
  await tx.update(storageObjects).set({ sha256: normalized }).where(
    eq(storageObjects.storage_url, storageUrl),
  );
  return normalized;
}
