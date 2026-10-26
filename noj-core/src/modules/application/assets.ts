/**
 * assets 应用编排用例。
 *
 * 存储容量保护横跨两个 owner：
 * - **assets** 拥有对象登记、上传预约与域存储归属事实（`storage_objects`、
 *   `domain_storage_objects`、`domain_storage_uploads`）；
 * - **access** 拥有域资源计数器（`domain_resource_counters`）。
 *
 * 本文件是两者唯一的组合点：application 在**同一个外层事务**里先完成对象/预约
 * 事实，再经 access 的计数合同调整 used/reserved，保持已验收的
 * 「对象 → 计数」锁序。业务模块（evaluations 产物提交、problems 支持包）只调用
 * 这里的用例，不再自行拼装跨 owner 事务。
 *
 * provider I/O 必须在数据库锁外：调用方先上传物理字节，再在事务内结算；
 * 或先在本文件的预约用例里登记意图，再上传，最后结算。
 */
import { getDb } from "../../shared/db/connection.ts";
import type { DbTx } from "../../shared/db/executor.ts";
import {
  attachDomainStorageUploadTx,
  getDomainOwnedStorageBytes,
  getDomainStorageUsage,
  growDomainStorageUploadTx,
  releaseDomainStorageObjectTx,
  releaseDomainStorageUploadTx,
  reserveDomainStorageUploadTx,
  settleDomainStorageUploadTx,
} from "../assets/services/storage-quota.ts";
import type { UserActor } from "../access/contracts/actor.ts";

/** 上传预约输入；`bytes` 为**预计新增**字节（内容寻址复用传 0）。 */
export interface ReserveUploadInput {
  readonly domainId: string;
  readonly bytes: number;
  readonly id?: string;
  readonly ttlMs?: number;
  readonly storageUrl?: string;
}

/**
 * 预约一次域存储上传。
 *
 * 容量判断与预约行在同一事务提交：超出上限时不会留下半条预约。
 * `storageUrl` 已知时先确认同域是否已保留该对象，内容复用的字节按 0 计。
 */
export async function reserveUploadCommand(input: ReserveUploadInput) {
  return await getDb().transaction(async (tx) => {
    const owned = input.storageUrl
      ? await getDomainOwnedStorageBytes(input.domainId, input.storageUrl)
      : null;
    return await reserveDomainStorageUploadTx({
      ...input,
      bytes: owned === null ? input.bytes : 0,
    }, tx);
  });
}

/** 预约输入已由调用方在事务中准备时使用；必须传入真实 `DbTx`。 */
export function reserveUploadCommandTx(
  input: ReserveUploadInput,
  tx: DbTx,
) {
  return reserveDomainStorageUploadTx(input, tx);
}

/** 流式上传在每批字节写入前增补容量；超额在物理写入之前失败。 */
export function growUploadCommand(
  domainId: string,
  reservationId: string,
  extraBytes: number,
) {
  return getDb().transaction((tx) =>
    growDomainStorageUploadTx(domainId, reservationId, extraBytes, tx)
  );
}

/** 上传完成后按实际对象大小结算，释放预占并计入 used。 */
export function settleUploadCommand(
  domainId: string,
  reservationId: string,
  storageUrl: string,
) {
  return getDb().transaction((tx) =>
    settleDomainStorageUploadTx(domainId, reservationId, storageUrl, tx)
  );
}

/** 结算必须与业务引用写入同一事务时使用。 */
export function settleUploadCommandTx(
  domainId: string,
  reservationId: string,
  storageUrl: string,
  tx: DbTx,
) {
  return settleDomainStorageUploadTx(domainId, reservationId, storageUrl, tx);
}

/** 失败/取消释放预约；重复释放不改变已结算的占用。 */
export function releaseUploadCommand(domainId: string, reservationId: string) {
  return getDb().transaction((tx) =>
    releaseDomainStorageUploadTx(domainId, reservationId, tx)
  );
}

/**
 * 把已知对象定位绑定到预约上（崩溃后可按定位核对物理对象）。
 *
 * 必须与业务引用写入处于同一事务：本函数不开启事务，也不回退根连接。
 */
export function attachUploadCommandTx(
  domainId: string,
  reservationId: string,
  storageUrl: string,
  tx: DbTx,
) {
  return attachDomainStorageUploadTx(
    domainId,
    reservationId,
    storageUrl,
    tx,
  );
}

/** 引用守卫确认物理删除后释放各所属域的实际占用。 */
export function releaseObjectCommand(storageUrl: string) {
  return getDb().transaction((tx) =>
    releaseDomainStorageObjectTx(storageUrl, tx)
  );
}

/** 运维/治理读取当前域存储占用（used/reserved）。 */
export function readStorageUsageCommand(domainId: string) {
  return getDomainStorageUsage(domainId);
}

/** 存储用例的显式操作者；当前仅用于审计元数据，容量核算不使用身份。 */
export interface AssetsCommandContext {
  readonly actor: UserActor;
}
