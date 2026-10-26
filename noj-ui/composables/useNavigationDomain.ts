import { safeAuthRedirect } from '~/utils/authRedirect';
import { workspaceSlugFromPath } from '~/utils/workspace';

/** 账号页面仅继承导航来源；业务权限和提交归属始终取明确域 URL。 */
export function useNavigationDomain() {
  const route = useRoute();
  const workspaces = useWorkspaceApi();
  const instance = useAsyncData('instance-navigation', () => workspaces.instance());
  return computed(() =>
    workspaceSlugFromPath(route.path) ??
      workspaceSlugFromPath(safeAuthRedirect(route.query.redirect, '')) ??
      (typeof route.query.domain === 'string' ? workspaceSlugFromPath(`/d/${route.query.domain}`) : null) ??
      instance.data.value?.data.default_domain_slug ?? 'main'
  );
}
