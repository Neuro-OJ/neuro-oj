import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, effectScope, onScopeDispose, reactive, ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { useCommunityScope } from '~/composables/useCommunityScope';
import { useCommunityNotifications } from '~/composables/useCommunityNotifications';
import CommunityBookmarks from '~/components/feature/community/CommunityBookmarks.vue';
vi.mock('~/composables/useToast', () => ({ useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }) }));

const route = reactive({ path: '/d/school-a/community/bookmarks' });
const user = ref<{ id: string } | null>({ id: 'student' });
const api = { get: vi.fn(), post: vi.fn() }, confirm = vi.fn();
const state = new Map<string, ReturnType<typeof ref>>();
beforeEach(() => {
  vi.clearAllMocks();
  state.clear();
  route.path = '/d/school-a/community/bookmarks';
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
  vi.stubGlobal('useDialog', () => ({ dialog: { confirm } }));
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
  it('旧域迟到的未读数不能出现在新域或账号通知角标', async () => {
    const lifetime = effectScope();
    const domain = lifetime.run(() => useCommunityNotifications())!;
    let finish!: (value: unknown) => void;
    api.get.mockReturnValueOnce(
      new Promise((done) => {
        finish = done;
      }),
    );
    const loading = domain.loadUnreadCount();
    route.path = '/d/school-b/community';
    finish({ data: { unread_count: 9 } });
    await loading;
    expect(domain.unreadCount.value).toBe(0);
    api.get.mockResolvedValue({ data: { count: 2 } });
    await domain.loadUnreadCount();
    expect(domain.unreadCount.value).toBe(2);
    const account = lifetime.run(() => useCommunityNotifications(true))!;
    expect(account.unreadCount.value).toBe(0);
    await account.loadUnreadCount();
    expect(api.get.mock.lastCall?.[0]).toBe('/api/v1/community/notifications/unread-count');
    user.value = null;
    expect(account.unreadCount.value).toBe(0);
    lifetime.stop();
  });
  it('取消收藏确认期间切换空间不会发送旧操作，收藏链接保持本域', async () => {
    vi.stubGlobal('onMounted', (fn: () => void) => fn());
    const post = {
      id: 'post',
      public_id: 'p-visible',
      type: 'discussion',
      title: '本域收藏',
      content: 'text',
      status: 'published',
    };
    api.get.mockResolvedValue({
      data: [{
        post,
        author: { id: 'author', username: 'author' },
        bookmarked_at: '2026-10-13',
        likes: 0,
        comments: 0,
      }],
      next_cursor: null,
    });
    const view = mount(CommunityBookmarks, {
      global: {
        stubs: {
          UButton: { template: '<button><slot /></button>' },
          UIcon: true,
          UserIdentity: true,
          NuxtTime: true,
          NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
        },
      },
    });
    await flushPromises();
    expect(view.find('a').attributes('href')).toBe('/d/school-a/community/posts/p-visible');
    let finish!: (value: boolean) => void;
    confirm.mockReturnValue(
      new Promise((done) => {
        finish = done;
      }),
    );
    await view.findAll('button').find((button) => button.text() === '取消收藏')!.trigger('click');
    route.path = '/d/school-b/community';
    finish(true);
    await flushPromises();
    expect(api.post).not.toHaveBeenCalled();
    view.unmount();
  });
});
