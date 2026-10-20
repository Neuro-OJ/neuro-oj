/**
 * @deprecated 存储配额已归 assets。保留此路径只为迁移期兼容旧调用方；新代码
 * 必须从 `modules/assets` 的窄门面导入。
 */
export {
  attachDomainStorageUpload,
  attachDomainStorageUploadTx,
  getDomainOwnedStorageBytes,
  getDomainStorageUsage,
  growDomainStorageUpload,
  growDomainStorageUploadTx,
  listDomainStorageBaselineObjects,
  listDomainStorageReconciliationDomains,
  listExpiredDomainStorageUploads,
  reconcileDomainStorageCounters,
  releaseDomainStorageObject,
  releaseDomainStorageObjectTx,
  releaseDomainStorageUpload,
  releaseDomainStorageUploadTx,
  reserveDomainStorageUpload,
  reserveDomainStorageUploadTx,
  settleDomainStorageUpload,
  settleDomainStorageUploadTx,
} from "../../../modules/assets/legacy.ts";
