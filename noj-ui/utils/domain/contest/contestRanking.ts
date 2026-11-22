/**
 * 竞赛封榜视图的前端判定与文案（VULN-09，纯逻辑放 utils 以便单测）。
 *
 * 后端约定（VULN-09 修复后）：
 * - `view = 'frozen'`（封榜期）时，**非管理员同样只返回选手本人一行**；
 * - 未登录 / 未参赛访问封榜榜 → 401 / 403，而不是空数组；
 * - 管理员仍可查看实时完整榜（`admin_live = true`）；
 * - 竞赛结束后 `view = 'official'`（或 live + 正式成绩版本），恢复完整榜单。
 *
 * 前端职责**仅限于如实说明**：把"只返回本人一行"渲染成正常视图 + 提示，
 * 不得放宽任何权限判断（后端才是权限的裁决方），也不得把它当成错误或空态崩溃。
 */

/** 榜单视图种类（与后端 `view` 字段对齐）。 */
export type ContestRankingView = 'live' | 'frozen' | 'official';

/** 封榜期间只显示本人成绩时的提示文案。 */
export const FROZEN_SELF_ONLY_HINT = '封榜期间仅显示本人成绩，赛后可查看完整榜单';

/** 进行中（未封榜）只显示本人排名时的提示文案（issue #583）。 */
export const LIVE_SELF_ONLY_HINT = '竞赛进行中仅显示你本人的排名，正式成绩发布后可查看完整榜单';

/** 未登录访问封榜榜单（401）时的引导文案。 */
export const FROZEN_LOGIN_HINT = '登录并报名参赛后可查看本场竞赛的封榜成绩';

/**
 * 是否为"封榜 + 仅本人一行"视图。
 *
 * @param view 后端返回的 `view`；缺失时按 `live` 处理（旧后端兼容）。
 * @param adminLive 后端返回的 `admin_live`；管理员实时完整榜不属于"仅本人"。
 */
export function isFrozenSelfOnly(
  view?: ContestRankingView | null,
  adminLive?: boolean | null,
): boolean {
  return view === 'frozen' && adminLive !== true;
}

/**
 * 封榜相关访问失败的降级文案。
 *
 * 401/403 在封榜语境下不是"出错"，而是"你没有可见的完整榜单"：
 * 后端刻意用状态码而非空数组表达，前端据此给出引导而不是裸露错误。
 *
 * @param status HTTP 状态码；非 401/403 时返回 null（由调用方按普通错误展示）。
 * @returns 展示文案；不适用时为 null。
 */
export function frozenAccessHint(status?: number | null): string | null {
  if (status === 401) return FROZEN_LOGIN_HINT;
  if (status === 403) return FROZEN_SELF_ONLY_HINT;
  return null;
}

/**
 * 是否为"进行中实时榜 + 仅本人一行"视图（issue #583）。
 *
 * 后端对非管理员在 `running` 期间无论 `ranking_visibility` 取何值都只返回本人一行；
 * 未封榜时 `view = 'live'`，前端需结合竞赛状态判定，避免用户把"只有自己"误读为数据缺失。
 *
 * @param view 后端返回的 `view`；缺失时按 `live` 处理（旧后端兼容）。
 * @param adminLive 后端返回的 `admin_live`；管理员实时完整榜不属于"仅本人"。
 * @param contestStatus 竞赛状态；仅 `running` 时成立。
 */
export function isLiveSelfOnly(
  view: ContestRankingView | null | undefined,
  adminLive: boolean | null | undefined,
  contestStatus: string | null | undefined,
): boolean {
  return (view ?? 'live') === 'live' && adminLive !== true && contestStatus === 'running';
}
