import { computed, inject, onScopeDispose, provide, ref, watch } from 'vue';
import type { InjectionKey } from 'vue';
import { useApi } from '~/composables/useApi';
import { workspaceCacheKey, workspacePath, workspaceSlugFromPath } from '~/utils/workspace';
import type {
  WorkspaceDetail,
  WorkspaceLimits,
  WorkspaceLimitUsage,
  WorkspaceMember,
  WorkspacePreset,
  WorkspaceRecord,
  WorkspaceSummary,
} from '~/utils/workspace';

import { extractApiError } from '~/utils/apiError';

/** 当前空间始终由 URL 解析；异步数据按查看者分隔，切换期间不使用旧权限。 */
export function provideWorkspaceContext() {
  const route = useRoute();
  const actor = useState<{ id: string } | null>('auth:user', () => null);
  const slug = computed(() => workspaceSlugFromPath(route.path));
  const { api } = useApi();
  const key = computed(() => workspaceCacheKey(slug.value ?? '', actor.value?.id ?? null));
  const state = useAsyncData<{ data: WorkspaceDetail | null }>(
    key,
    async () => {
      if (!slug.value) return { data: null };
      const viewer = actor.value?.id ?? null;
      const response = await api.get<{ data: WorkspaceDetail }>(`/api/v1/domains/${slug.value}`, { silent: true });
      if (response.data.actor_id !== viewer) throw new Error('登录身份已变化，请刷新页面');
      return response;
    },
    { watch: [slug, () => actor.value?.id] },
  );

  const isAuthOrNotFound = computed(() => {
    if (!state.error.value) return false;
    const errStatus = extractApiError(state.error.value).status;
    return errStatus === 401 || errStatus === 403 || errStatus === 404;
  });

  const lastSuccessfulData = ref<WorkspaceDetail | null>(null);

  watch(key, () => {
    lastSuccessfulData.value = null;
  });

  watch(
    () => state.data.value?.data,
    (newData) => {
      if (newData && state.status.value === 'success') {
        lastSuccessfulData.value = newData;
      }
    },
    { immediate: true },
  );

  const domain = computed(() => {
    if (isAuthOrNotFound.value) {
      lastSuccessfulData.value = null;
      return null;
    }
    const result = state.data.value?.data ?? lastSuccessfulData.value;
    return result?.slug === slug.value && result.actor_id === (actor.value?.id ?? null) ? result : null;
  });

  const can = (permission: string) =>
    !isAuthOrNotFound.value &&
    !!domain.value &&
    (domain.value.platform_admin || domain.value.permissions.includes(permission));

  const writable = computed(() =>
    !state.error.value &&
    state.status.value === 'success' &&
    domain.value?.status === 'active'
  );

  const context = { ...state, domain, slug, can, writable };
  provide(workspaceContextKey, context);
  return context;
}

const workspaceContextKey: InjectionKey<ReturnType<typeof provideWorkspaceContext>> = Symbol('workspace-context');
/** 共享导航在账号页没有域布局；域页面直接复用布局已解析的上下文。 */
export function useOptionalWorkspace() {
  return inject(workspaceContextKey, null);
}
/** 子页面复用所属布局的解析，不重复触发上下文读取或依赖全局当前域。 */
export function useWorkspace() {
  const context = inject(workspaceContextKey);
  if (!context) throw new Error('空间页面需要工作空间布局');
  return context;
}

/** 确认框或请求结束后，旧页面不能把操作重新指向新域或新账号。 */
export function useWorkspaceActionScope() {
  const context = useWorkspace();
  const actor = useState<{ id: string } | null>('auth:user', () => null);
  let mounted = true;
  onScopeDispose(() => {
    mounted = false;
  });
  return () => {
    const slug = context.slug.value;
    const actorId = actor.value?.id;
    if (!slug || !actorId) throw new Error('操作需要当前空间及登录身份');
    return {
      slug,
      isCurrent: () => mounted && context.slug.value === slug && actor.value?.id === actorId,
    };
  };
}

/** 所有管理操作显式携带路径域；导航偏好仅在用户主动进入时更新。 */
export function useWorkspaceApi() {
  const { api } = useApi();
  const path = (slug: string) => `/api/v1/domains/${workspacePath(slug).slice(3)}`;
  const revision = (value: number) => ({ headers: { 'If-Match': String(value) } });
  return {
    list: (mine = false) =>
      api.get<{ data: WorkspaceSummary[] }>(mine ? '/api/v1/me/domains' : '/api/v1/domains', {
        silent: true,
        redirectOnUnauthorized: false,
      }),
    instance: () =>
      api.get<
        {
          data: {
            access: 'public' | 'authenticated';
            default_domain_slug: string;
            domain_creation_policy: 'admin' | 'approval' | 'open';
            modules: WorkspaceDetail['configuration']['features'];
          };
        }
      >('/api/v1/instance', { silent: true }),
    create: (input: { slug: string; name: string; preset: WorkspacePreset; description: string }) =>
      api.post<{ data: WorkspaceRecord }>('/api/v1/domains', input),
    requestCreation: (input: { slug: string; name: string; preset: WorkspacePreset; reason: string }) =>
      api.post('/api/v1/domain-creation-requests', input),
    members: (slug: string, options?: number | { page?: number; per_page?: number; keyword?: string }) => {
      const query = typeof options === 'number' ? { page: options } : {
        page: options?.page ?? 1,
        per_page: options?.per_page ?? 25,
        keyword: options?.keyword || undefined,
      };
      return api.get<
        {
          data: WorkspaceMember[];
          page: number;
          per_page: number;
          pagination?: { page: number; per_page: number; total: number; total_pages: number };
        }
      >(`${path(slug)}/members`, {
        query,
        silent: true,
      });
    },
    join: (slug: string, reason: string) =>
      api.post<{ data: { membership?: unknown; request?: unknown } }>(`${path(slug)}/join`, { reason }),
    update: (
      slug: string,
      input: { name?: string; description?: string; configuration?: Partial<WorkspaceDetail['configuration']> },
      current: number,
    ) => api.patch(`${path(slug)}`, input, revision(current)),
    limits: (slug: string) =>
      api.get<
        {
          data: {
            configured: WorkspaceLimits;
            effective: WorkspaceLimits;
            caps: WorkspaceLimits;
            revision: number;
            usage: WorkspaceLimitUsage;
          };
        }
      >(`${path(slug)}/limits`, { silent: true }),
    updateLimits: (slug: string, input: WorkspaceLimits, current: number) =>
      api.patch(`${path(slug)}/limits`, input, revision(current)),
    status: (slug: string, status: WorkspaceDetail['status'], current: number) =>
      api.post(`${path(slug)}/status`, { status }, revision(current)),
    remember: (slug: string) => api.put('/api/v1/me/workspace-preference', { slug }, { silent: true }),
  };
}
