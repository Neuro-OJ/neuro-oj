/**
 * legal 域门面（PIPL 合规）。
 *
 * 其他域（如 identity 注册路径）只经此门面引用本域能力。
 */
export { isLegalKind, LEGAL_KINDS } from "./types.ts";
export type {
  LegalConsentStatus,
  LegalDocumentSnapshot,
  LegalKind,
  LegalVersionSummary,
  UserConsentSnapshot,
} from "./types.ts";
export {
  getConsentedVersions,
  getLegalStatus,
  getUserConsent,
  recordConsent,
  recordConsentsForRegistration,
} from "./services/consent.ts";
export {
  getCurrentDocument,
  getRequiredConsentInfo,
  getRequiredConsentVersion,
  getVersionTsa,
  hashContent,
  listVersions,
  publishVersion,
} from "./services/documents.ts";
export {
  buildTimeStampQuery,
  timestampHash,
  tsaEnabled,
  verifyTimestamp,
} from "./services/tsa.ts";
export {
  createDataRequest,
  DATA_REQUEST_KINDS,
  DATA_REQUEST_STATUSES,
  DATA_REQUEST_TARGETS,
  listAllDataRequests,
  listUserDataRequests,
  updateDataRequestStatus,
} from "./services/data-requests.ts";
export type {
  DataRequestKind,
  DataRequestRow,
  DataRequestStatus,
  DataRequestTarget,
} from "./services/data-requests.ts";
