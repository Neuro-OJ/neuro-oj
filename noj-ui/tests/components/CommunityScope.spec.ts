import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, effectScope, onScopeDispose, reactive, ref } from 'vue';
import { useCommunityScope } from '~/composables/useCommunityScope';
import { useAccountNotifications } from '~/composables/useAccountNotifications';
vi.mock('~/composables/useToast', () => ({ useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }) }));

const route = reactive({ path: '/d/school-a/community' });
const user = ref<{ id: string } | null>({ id: 'student' });
const api = { get: vi.fn(), post: vi.fn() };
const state = new Map<string, ReturnType<typeof ref>>();
beforeEach(() => {
  vi.clearAllMocks();
  state.clear();
  route.path = '/d/school-a/community';
  user.value = { id: 'student' };
  vi.stubGlobal('ref', ref);
  vi.stubGlobal('computed', computed);
  vi.stubGlobal('onScopeDispose', onScopeDispose);
  vi.stubGlobal('useRoute', () => route);
  vi.stubGlobal('useAuth', () => ({ user }));
  vi.stubGlobal('useCommunityScope', useCommunityScope);
  vi.stubGlobal('useApi', () => ({ api }));
  vi.stubGlobal('useState', (key: string, init: () => unknown) => {
    if (!state.has(key)) state.set(key, ref(init()));
    return state.get(key);
  });
});
describe('域社区作用域与异步交互', () => {
  it('已捕获请求不会改写目标域，切域、切账号和卸载都撤销后续动作', () => {
    const lifetime = effectScope();
    const scope = lifetime.run(() => useCommunityScope())!;
    const original = scope.capture();
    route.path = '/d/school-b/community';
    expect(original.apiPath('posts')).toBe('/api/v1/domains/school-a/community/posts');
    expect(original.isCurrent()).toBe(false);
    const next = scope.capture();
    user.value = { id: 'teacher' };
    expect(next.isCurrent()).toBe(false);
    const current = scope.capture();
    lifetime.stop();
    expect(current.isCurrent()).toBe(false);
  });
  it('通知角标跨域共享，旧账号迟到的未读数不能覆盖当前账号', async () => {
    const badge = useAccountNotifications();
    let finish!: (value: unknown) => void;
    api.get.mockReturnValueOnce(
      new Promise((done) => {
        finish = done;
      }),
    );
    const loading = badge.refresh();
    user.value = { id: 'teacher' };
    finish({ unread_count: 9 });
    await loading;
    expect(badge.unreadCount.value).toBe(0);
    api.get.mockResolvedValue({ unread_count: 2 });
    await badge.refresh();
    route.path = '/d/school-b/community';
    expect(badge.unreadCount.value).toBe(2);
    expect(api.get.mock.lastCall?.[0]).toBe('/api/v1/notifications');
    user.value = null;
    expect(badge.unreadCount.value).toBe(0);
  });
});
