/**
 * 政策变更同意弹窗的判定逻辑（纯函数，便于单测）。
 *
 * 口径（与后端 `/auth/me` 的 `legal` 字段一致）：
 * - 只对**重大变更**（`is_material=true`）要求重新同意；错字/排版类修订不打扰用户。
 * - `needs_consent=true` 且 `is_material=true` 时才弹窗，且**不可关闭**。
 */

/** 单份文档的同意状态（来自 `/auth/me` 的 `data.legal`）。 */
export interface LegalConsentStatus {
  required_version: number;
  agreed_version: number;
  needs_consent: boolean;
  is_material: boolean;
  /** 需同意的重大版本的变更摘要；无需同意时为 null */
  change_summary?: string | null;
}

/** `/auth/me` 的 `data.legal` 结构。 */
export type LegalStatusMap = Record<string, LegalConsentStatus>;

/** 文档类型的中文名（弹窗展示用）。 */
export const LEGAL_KIND_LABELS: Record<string, string> = {
  privacy: '隐私政策',
  terms: '服务条款',
};

/** 需要用户重新同意的文档条目。 */
export interface PendingConsent {
  kind: string;
  label: string;
  requiredVersion: number;
  agreedVersion: number;
  /** 该重大版本的变更摘要（可空） */
  changeSummary: string | null;
}

/**
 * 从 `/auth/me` 的 legal 状态中挑出需要弹窗的文档。
 *
 * @param legal `/auth/me` 的 `data.legal`；未登录/后端未返回时为 undefined
 * @returns 需重新同意的文档列表；无需同意时为空数组
 */
export function collectPendingConsents(
  legal: LegalStatusMap | undefined | null,
): PendingConsent[] {
  if (!legal) return [];
  const out: PendingConsent[] = [];
  for (const [kind, status] of Object.entries(legal)) {
    if (status?.needs_consent && status.is_material) {
      out.push({
        kind,
        label: LEGAL_KIND_LABELS[kind] ?? kind,
        requiredVersion: status.required_version,
        agreedVersion: status.agreed_version,
        changeSummary: status.change_summary ?? null,
      });
    }
  }
  return out;
}
