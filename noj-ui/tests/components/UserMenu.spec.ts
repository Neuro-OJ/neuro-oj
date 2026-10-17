/**
 * UserMenu 未读消息角标回归测试（#657）。
 *
 * 背景：`/api/v1/conversations/unread-count` 返回顶层 `{ unread_count }`，
 * Nitro 代理透传、`useApi` 不解包，但组件曾按 `res.data.unread_count` 读取，
 * 导致 `res.data` 恒为 undefined、角标恒为 0。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';

import UserMenu from '~/components/layout/UserMenu.vue';

const isLoggedIn = ref(true);
const user = ref<{ username: string; is_admin: boolean; avatar_url?: string | null }>({
  username: 'alice',
  is_admin: false,
  avatar_url: null,
});
const apiGet = vi.fn();

beforeAll(() => {
  vi.stubGlobal('useAuth', () => ({
    user,
    isLoggedIn,
    logout: vi.fn(),
    fetchUser: vi.fn(),
  }));
  vi.stubGlobal('useDialog', () => ({ dialog: { confirm: vi.fn() } }));
  vi.stubGlobal('useApi', () => ({ api: { get: apiGet, post: vi.fn() } }));
  vi.stubGlobal('useRouter', () => ({ push: vi.fn() }));
});

const stubs = {
  UIcon: true,
  UButton: { template: '<button><slot /></button>' },
  NuxtLink: { template: '<a><slot /></a>' },
  UserIdentity: true,
};

function mountMenu() {
  return mount(UserMenu, { global: { stubs } });
}

afterEach(() => {
  apiGet.mockReset();
});

describe('UserMenu 未读消息角标', () => {
  it('按顶层 unread_count 渲染角标（回归 #657）', async () => {
    apiGet.mockResolvedValue({ unread_count: 3 });
    const wrapper = mountMenu();
    await flushPromises();

    expect(apiGet).toHaveBeenCalledWith('/api/v1/conversations/unread-count', { silent: true });
    expect(wrapper.get('[data-test="unread-badge"]').text()).toBe('3');
    wrapper.unmount();
  });

  it('未读数为 0 时不渲染角标', async () => {
    apiGet.mockResolvedValue({ unread_count: 0 });
    const wrapper = mountMenu();
    await flushPromises();

    expect(wrapper.find('[data-test="unread-badge"]').exists()).toBe(false);
    wrapper.unmount();
  });
});
