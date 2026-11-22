/**
 * 邀请赛选题的保密风险提示契约（VULN-04 / VULN-05）。
 *
 * 平台**不会**对邀请赛挂载的公开题（`visibility = 'public'`）做全站保密遮蔽——
 * 这是防止普通用户借邀请赛劫持公共题库的反 DoS 设计。因此"挂了公开题以为
 * 全站都看不到"是真实且高发的认知风险，需要在选题时显式提示。
 *
 * 本模块只提供**提示与引导**：不阻塞保存、不改变任何权限模型、
 * 也不额外发请求；可见性字段直接来自
 * `GET /api/v1/admin/catalog/problems`（后端已返回 `visibility`）。
 */

/** 邀请赛挂载公开题时的风险提示文案。 */
export const INVITE_PUBLIC_PROBLEM_WARNING =
  '若希望比赛题目对外完全保密，请务必使用您名下的私有题目（Private）。公开题目无法在全站隐藏，仍允许公共练习。';

/** 题目可见性最小形状（`AdminProblemOption` 的可见性子集）。 */
export interface ProblemVisibilityRef {
  id: string;
  visibility?: 'public' | 'private';
}

/**
 * 从已选题目中挑出可见性为 `public` 的题目 id。
 *
 * 只依据后端真实下发的 `visibility` 判定：题目不在候选项列表里（例如编辑已存在的
 * 竞赛、候选项未加载到该题）时**不猜测**，视作"未知"而不提示，避免误导管理员。
 *
 * @param selectedProblemIds 已选题目 id（保持页面顺序）。
 * @param options 候选题列表（含 `visibility`）。
 * @returns 命中公开可见性的题目 id，顺序同入参。
 */
export function selectedPublicProblemIds(
  selectedProblemIds: readonly string[],
  options: readonly ProblemVisibilityRef[],
): string[] {
  const visibilityById = new Map(options.map((option) => [option.id, option.visibility]));
  return selectedProblemIds.filter((id) => visibilityById.get(id) === 'public');
}

/**
 * 邀请赛场景下的公开题 id 列表（非邀请赛恒为空）。
 *
 * @param kind 竞赛类型：仅邀请赛（`invite`）存在该风险——公开赛题目本就全站保密。
 * @param selectedProblemIds 已选题目 id。
 * @param options 候选题列表。
 */
export function invitePublicProblemIds(
  kind: string | undefined,
  selectedProblemIds: readonly string[],
  options: readonly ProblemVisibilityRef[],
): string[] {
  if (kind !== 'invite') return [];
  return selectedPublicProblemIds(selectedProblemIds, options);
}

/**
 * 是否需要展示邀请赛公开题风险提示。
 *
 * @param kind 竞赛类型。
 * @param selectedProblemIds 已选题目 id。
 * @param options 候选题列表。
 */
export function needsInvitePublicWarning(
  kind: string | undefined,
  selectedProblemIds: readonly string[],
  options: readonly ProblemVisibilityRef[],
): boolean {
  return invitePublicProblemIds(kind, selectedProblemIds, options).length > 0;
}
