import { beforeAll, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import AdminTopbar from '~/components/admin/AdminTopbar.vue';

const mockUser = ref<{ username: string; is_admin: boolean; avatar_url?: string | null }>({
  username: 'superadmin',
  is_admin: true,
  avatar_url: null,
});
const mockFetchUser = vi.fn();
const mockRoute = ref({ path: '/admin/contests' });
const mockRuntimeConfig = {
  public: {
    buildInfo: {
      version: '0.10.2',
      commit: 'abc12345678',
      builtAt: '2026-09-30T00:00:00Z',
    },
  },
};

beforeAll(() => {
  vi.stubGlobal('useAuth', () => ({ user: mockUser, fetchUser: mockFetchUser }));
  vi.stubGlobal('useRoute', () => mockRoute.value);
  vi.stubGlobal('useRuntimeConfig', () => mockRuntimeConfig);
});

const stubs = {
  UIcon: true,
  NuxtLink: {
    template: '<a><slot /></a>',
  },
  UserIdentity: {
    props: ['user'],
    template: '<span data-test="user-identity">{{ user.username }}</span>',
  },
};

describe('AdminTopbar 全局管理顶栏', () => {
  it('正确解析当前路由的面包屑文案', () => {
    mockRoute.value = { path: '/admin/contests' };
    const wrapper = mount(AdminTopbar, {
      props: { sidebarOpen: true, isMobile: false },
      global: { stubs },
    });
    expect(wrapper.text()).toContain('题务教务');
    expect(wrapper.text()).toContain('竞赛管理');
  });

  it('展示环境指示芯片，并通过 UserIdentity 渲染管理员头像', () => {
    const wrapper = mount(AdminTopbar, {
      props: { sidebarOpen: true, isMobile: false },
      global: { stubs },
    });
    expect(wrapper.text()).toContain('本地开发');
    expect(wrapper.text()).toContain('superadmin');
    expect(wrapper.find('[data-test="user-identity"]').exists()).toBe(true);
  });

  it('点击搜索或侧栏按钮时触发对应 emit 事件', async () => {
    const wrapper = mount(AdminTopbar, {
      props: { sidebarOpen: true, isMobile: false },
      global: { stubs },
    });

    const searchBtn = wrapper.find('button[type="button"]');
    await searchBtn.trigger('click');
    expect(wrapper.emitted('toggle-sidebar')).toBeTruthy();
  });

  it('旧 session 缺少 avatar_url 时刷新一次用户资料', () => {
    mockFetchUser.mockClear();
    mockUser.value = { username: 'superadmin', is_admin: true };
    mount(AdminTopbar, {
      props: { sidebarOpen: true, isMobile: false },
      global: { stubs },
    });
    expect(mockFetchUser).toHaveBeenCalledTimes(1);

    mockFetchUser.mockClear();
    mockUser.value = { username: 'superadmin', is_admin: true, avatar_url: null };
    mount(AdminTopbar, {
      props: { sidebarOpen: true, isMobile: false },
      global: { stubs },
    });
    expect(mockFetchUser).not.toHaveBeenCalled();
  });
});
