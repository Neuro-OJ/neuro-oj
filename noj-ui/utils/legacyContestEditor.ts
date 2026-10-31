/**
 * 旧竞赛编辑器深链接的收敛目标（纯函数，便于单测）。
 *
 * 域隔离之前，竞赛作答走 `/editor/:problemId?contest=<id>&label=<label>`；它的提交
 * 调用 `POST /api/v1/contests/:id/submit` 在生产环境返回 410，读取也只保留到 0.12。
 *
 * 目标固定 `main`：旧无域入口的授权本来就固定默认域（`resolveDefaultContestAccess`），
 * 换成别的 slug 会把旧链接指向它原本无权访问的比赛。
 *
 * 缺参数时返回 null（不猜题号），由页面呈现既有报错。
 */
export function legacyContestEditorDestination(
  path: string,
  query: Record<string, unknown>,
): string | null {
  if (path !== '/editor' && !path.startsWith('/editor/')) return null;
  const contest = query.contest;
  const label = query.label;
  if (typeof contest !== 'string' || contest.length === 0) return null;
  if (typeof label !== 'string' || label.length === 0) return null;
  return `/d/main/contests/${encodeURIComponent(contest)}/solve/${encodeURIComponent(label)}`;
}
