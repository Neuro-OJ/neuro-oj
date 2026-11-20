/**
 * legal 域类型定义（PIPL 合规）。
 */

/** 法律文档类型。 */
export const LEGAL_KINDS = ["privacy", "terms"] as const;
export type LegalKind = (typeof LEGAL_KINDS)[number];

/** 类型守卫：字符串是否为合法文档类型。 */
export function isLegalKind(value: string): value is LegalKind {
  return (LEGAL_KINDS as readonly string[]).includes(value);
}

/** 当前文档快照（含正文）。 */
export interface LegalDocumentSnapshot {
  kind: LegalKind;
  version: number;
  content: string;
  content_hash: string;
  is_material: boolean;
}

/** 版本历史条目（不含正文）。 */
export interface LegalVersionSummary {
  version: number;
  published_at: string;
  is_material: boolean;
  change_summary: string | null;
}

/** 用户在某文档上的同意状态。 */
export interface UserConsentSnapshot {
  version: number;
  agreed_at: string;
}

/** `/auth/me` 中单份文档的同意状态。 */
export interface LegalConsentStatus {
  required_version: number;
  agreed_version: number;
  needs_consent: boolean;
  is_material: boolean;
}
