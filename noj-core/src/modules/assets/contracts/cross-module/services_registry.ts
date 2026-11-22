/** 跨模块窄能力合同；只列出生产调用方实际需要的符号。 */
export {
  assertStorageObjectBindable,
  compensateUploadedObject,
  deleteStorageObject,
  getStorageObject,
  registerLegacyStorageObject,
  registerReadyStorageObject,
  registerStreamedStorageObject,
  uploadStorageObjectWithReservation,
} from "../../services/registry.ts";
