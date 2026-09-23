/**
 * legal 域门面（PIPL 合规）。
 *
 * 其他域（如 identity 注册路径）只经此门面引用本域能力。
 */
export * from "./types.ts";
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
  hashContent,
  listVersions,
  publishVersion,
} from "./services/documents.ts";
export { timestampHash, tsaEnabled } from "./services/tsa.ts";
export * from "./services/data-requests.ts";
