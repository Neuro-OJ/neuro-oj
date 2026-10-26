import { safeAuthRedirect } from '~/utils/authRedirect';
import { workspaceSlugFromPath } from '~/utils/workspace';

/** 账号页面仅继承导航来源；业务权限和提交归属始终取明确域 URL。 */
export function useNavigationDomain() {
  const route = useRouter().currentRoute;
  const workspaces = useWorkspaceApi();
  const instance = useViewAsyncData('instanceNavigation', 'instance-navigation', () => workspaces.instance());
  return computed(() =>
    workspaceSlugFromPath(route.value.path) ??
      workspaceSlugFromPath(safeAuthRedirect(route.value.query.redirect, '')) ??
      (typeof route.value.query.domain === 'string' ? workspaceSlugFromPath(`/d/${route.value.query.domain}`) : null) ??
      instance.data.value?.data.default_domain_slug ?? 'main'
  );
}
