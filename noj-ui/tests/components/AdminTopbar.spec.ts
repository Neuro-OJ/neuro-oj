import { beforeAll, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import AdminTopbar from '~/components/admin/AdminTopbar.vue';

const mockUser = ref({ username: 'superadmin', is_admin: true });
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
  vi.stubGlobal('useAuth', () => ({ user: mockUser }));
  vi.stubGlobal('useRoute', () => mockRoute.value);
  vi.stubGlobal('useRuntimeConfig', () => mockRuntimeConfig);
});

const stubs = {
  UIcon: true,
  NuxtLink: {
    template: '<a><slot /></a>',
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

  it('展示环境指示芯片，并包含管理员用户名缩写', () => {
    const wrapper = mount(AdminTopbar, {
      props: { sidebarOpen: true, isMobile: false },
      global: { stubs },
    });
    expect(wrapper.text()).toContain('本地开发');
    expect(wrapper.text()).toContain('superadmin');
    expect(wrapper.text()).toContain('SU');
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
});
