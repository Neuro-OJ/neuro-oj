import { communityApiPath, communityPath, communityScopeKey } from '~/utils/community-workspace';
import { workspaceSlugFromPath } from '~/utils/workspace';

/** URL 是内容域的唯一来源；账号通知与私信举报显式选择账号作用域。 */
export function useCommunityScope(account: boolean | (() => boolean) = false) {
  const route = useRouter().currentRoute;
  const { user } = useAuth();
  const slug = computed(() =>
    (typeof account === 'function' ? account() : account) ? null : workspaceSlugFromPath(route.value.path) ?? 'main'
  );
  const key = computed(() => communityScopeKey(slug.value, user.value?.id ?? null));
  let mounted = true;
  onScopeDispose(() => {
    mounted = false;
  });
  function capture() {
    const currentSlug = slug.value, currentKey = key.value;
    return {
      slug: currentSlug,
      key: currentKey,
      apiPath: (suffix = '') => communityApiPath(currentSlug, suffix),
      href: (suffix = '') => communityPath(currentSlug, suffix),
      isCurrent: () => mounted && key.value === currentKey,
    };
  }
  return { slug, key, capture };
}
