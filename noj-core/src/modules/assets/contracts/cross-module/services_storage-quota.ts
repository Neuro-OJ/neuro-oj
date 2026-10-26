/** 跨模块窄能力合同；只列出生产调用方实际需要的符号。 */
export {
  attachDomainStorageUpload,
  getDomainOwnedStorageBytes,
  growDomainStorageUpload,
  releaseDomainStorageUpload,
  reserveDomainStorageUpload,
  settleDomainStorageUpload,
} from "../../services/storage-quota.ts";
