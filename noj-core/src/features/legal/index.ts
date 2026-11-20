/**
 * 法律文档 / 同意 / 数据请求功能对外出口（见 README.md）。
 *
 * 其他功能与旧模块只能从这里引用本功能能力；本目录内部文件互相直接引用。
 */
import { defineFeature } from "../../shared/feature.ts";
import { legalRouter } from "./routes.ts";

export const feature = defineFeature({
  name: "legal",
  router: legalRouter,
});

export {
  getCurrentDocument,
  getRequiredConsentInfo,
  getRequiredConsentVersion,
  hashContent,
  listVersions,
  normalizeContent,
  publishVersion,
} from "./documents.ts";
export {
  getConsentedVersions,
  getLegalStatus,
  getUserConsent,
  recordConsent,
  recordConsentsForRegistration,
} from "./consent.ts";
export {
  createDataRequest,
  DATA_REQUEST_KINDS,
  DATA_REQUEST_STATUSES,
  DATA_REQUEST_TARGETS,
  listAllDataRequests,
  listUserDataRequests,
  updateDataRequestStatus,
} from "./data-requests.ts";
export type {
  DataRequestKind,
  DataRequestRow,
  DataRequestStatus,
  DataRequestTarget,
} from "./data-requests.ts";
export { isLegalKind, LEGAL_KINDS } from "./types.ts";
export type {
  LegalConsentStatus,
  LegalDocumentSnapshot,
  LegalKind,
  LegalVersionSummary,
  UserConsentSnapshot,
} from "./types.ts";
