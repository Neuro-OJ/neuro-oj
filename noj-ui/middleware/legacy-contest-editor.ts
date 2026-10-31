import { legacyContestEditorDestination } from '~/utils/legacyContestEditor';

/**
 * 旧竞赛编辑器入口收敛（深链接在渲染前整体转成域作答页）。
 *
 * 为什么不是"让它半可用"：`/editor/:id?contest=<id>&label=<label>` 的提交调用
 * `POST /api/v1/contests/:id/submit` 在生产环境返回 **410 ENDPOINT_RETIRED**，读取也只会
 * 保留到 0.12。301 + replace 让旧地址不再留在历史里，目标固定 `main` 是因为旧无域入口
 * 的授权本来就固定默认域。判定逻辑本身在 `utils/legacyContestEditor.ts`，有单测。
 */
export default defineNuxtRouteMiddleware((to) => {
  const destination = legacyContestEditorDestination(to.path, to.query);
  if (!destination) return;
  return navigateTo(destination, { redirectCode: 301, replace: true });
});
