import type { BffEnvelope, BffSnapshot } from '~/utils/bff-view';
import type { AuthUser } from '~/utils/auth-user';
import { bffSnapshotMatches, bffViewRoute } from '~/utils/bff-view';
import { extractApiError } from '~/utils/apiError';

/** 在页面守卫之前建立视图与真实身份；水合复用同一份 Nuxt payload。 */
export default defineNuxtRouteMiddleware(async (to) => {
  const generation = useState<number>('bff:generation', () => 0);
  const current = ++generation.value;
  const snapshot = useState<BffSnapshot | null>('bff:view', () => null);
  const actor = useState<AuthUser | null>('auth:user', () => null);
  const requestedActor = actor.value?.id ?? null;
  const pendingPath = useState<string | null>('bff:pending-path', () => null);
  const route = bffViewRoute(to.path);
  if (!route) {
    pendingPath.value = null;
    snapshot.value = null;
    return;
  }
  const app = useNuxtApp();
  if (app.isHydrating && bffSnapshotMatches(snapshot.value, to.fullPath, actor.value?.id ?? null)) return;
  pendingPath.value = to.fullPath.split('#')[0]!;
  snapshot.value = null;
  const { api } = useApi(to);
  const path = to.fullPath.split('#')[0]!;
  const key = `bff:${path}:${actor.value?.id ?? 'guest'}`;
  const { data, error } = await useAsyncData(key, (_app, { signal }) =>
    api.get<BffEnvelope>(route.endpoint, {
      query: to.query,
      signal,
      silent: true,
      redirectOnUnauthorized: false,
      retry: 0,
    }), { getCachedData: () => undefined });
  if (generation.value !== current || (actor.value?.id ?? null) !== requestedActor) return;
  if (error.value) {
    const info = extractApiError(error.value);
    if (info.code === 'MUST_CHANGE_PASSWORD') return navigateTo('/change-password');
    if (info.status === 401) {
      actor.value = null;
      return navigateTo({ path: '/login', query: { redirect: to.fullPath } });
    }
    throw createError({ statusCode: info.status ?? 502, message: info.message, data: error.value.data });
  }
  if (!data.value) throw createError({ statusCode: 502, message: '页面数据服务暂时不可用' });
  actor.value = data.value.viewer;
  useState<boolean>('auth:loading', () => false).value = false;
  snapshot.value = { path, actorId: actor.value?.id ?? null, envelope: data.value };
  if (actor.value?.must_change_password) return navigateTo('/change-password');
});
