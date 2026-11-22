import { defaultProblemReference, defaultWorkspaceDestination } from '~/utils/domain/workspace/default-workspace';
import { workspaceProblemPath, workspaceSolvePath } from '~/utils/domain/workspace/workspace';
import { isNotFoundError } from '~/utils/server/apiError';
import { contestProtectionFromError } from '~/utils/domain/contest/contestProtection';
/** 旧入口在页面 setup 前转到 main（规则见 `utils/domain/workspace/default-workspace.ts`），旧表单不再发起业务写操作。 */
export default defineNuxtRouteMiddleware(async (to) => {
    const destination = defaultWorkspaceDestination(to.path);
    if (!destination) return;
    const query = { ...to.query };
    // 静态路径段不区分大小写（与原 Vue Router 页面一致），`/Search` 仍是搜索页。
    const lower = to.path.toLowerCase();
    if (!lower.startsWith('/community') && lower !== '/search') delete query.type;
    if (
        lower === '/search' && query.type && !['problem', 'contest', 'submission', 'all'].includes(String(query.type))
    ) delete query.type;
    if ('path' in destination) {
        if (destination.kind) query.kind = destination.kind;
        if (destination.query) Object.assign(query, destination.query);
        return navigateTo({ path: destination.path, query, hash: to.hash }, { redirectCode: 301, replace: true });
    }
    if ('trainingRef' in destination) {
        // 旧链接的 public_id（tr-xxx）直接交给域内题单页，由它按域接口读取；无域
        // `/api/v1/trainings/:id` 已删除，不再经兼容门面换取内部 UUID。
        const path = `/d/main/trainings/${encodeURIComponent(destination.trainingRef)}`;
        return navigateTo({ path, query, hash: to.hash }, { redirectCode: 301, replace: true });
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
            const contests = contestProtectionFromError(error);
            if (contests) {
                throw createError({
                    statusCode: 403,
                    statusMessage: '赛题正在保护中',
                    data: { slug: 'main', contests },
                });
            }
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
