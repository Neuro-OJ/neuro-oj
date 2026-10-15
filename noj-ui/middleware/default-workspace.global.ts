import { defaultProblemReference, defaultWorkspaceDestination } from '~/utils/default-workspace';
import { workspaceProblemPath, workspaceSolvePath } from '~/utils/workspace';
import { isNotFoundError } from '~/utils/apiError';
/** 旧入口在页面 setup 前转到 main，旧表单不再发起业务写操作。 */
export default defineNuxtRouteMiddleware(async (to) => {
  const destination = defaultWorkspaceDestination(to.path);
  if (!destination) return;
  const query = { ...to.query };
  if (!to.path.startsWith('/community') && to.path !== '/search') delete query.type;
  if (
    to.path === '/search' && query.type && !['problem', 'contest', 'submission', 'all'].includes(String(query.type))
  ) delete query.type;
  if ('path' in destination) {
    if (destination.kind) query.kind = destination.kind;
    return navigateTo({ path: destination.path, query, hash: to.hash }, { redirectCode: 301, replace: true });
  }
  if ('trainingRef' in destination) {
    const { api } = useApi();
    const result = await api.get<{ data: { id: string } }>(
      `/api/v1/trainings/${encodeURIComponent(destination.trainingRef)}`,
      { silent: true },
    );
    return navigateTo({ path: `/d/main/trainings/${encodeURIComponent(result.data.id)}`, query, hash: to.hash }, {
      redirectCode: 301,
      replace: true,
    });
  }
  let reference = defaultProblemReference(destination.problemRef);
  if (!reference && !/^U\d+$/.test(destination.problemRef)) {
    // 仅用已收口 main 的只读兼容门面解析旧 UUID，失败不寻找其他域。
    const { api } = useApi();
    try {
      const result = await api.get<{ data: { number?: number; display_id?: string } }>(
        `/api/v1/problems/${encodeURIComponent(destination.problemRef)}`,
        { silent: true },
      );
      reference = defaultProblemReference(String(result.data.number ?? result.data.display_id ?? ''));
    } catch (error) {
      if (isNotFoundError(error)) throw createError({ statusCode: 404, statusMessage: '题目不存在' });
      throw error;
    }
  }
  if (!reference) throw createError({ statusCode: 404, statusMessage: '旧题目入口不存在' });
  const path = destination.editor
    ? `/d/main/editor/${encodeURIComponent(reference)}`
    : destination.solve
    ? workspaceSolvePath('main', reference)
    : workspaceProblemPath('main', reference);
  return navigateTo({ path, query, hash: to.hash }, { redirectCode: 301, replace: true });
});
