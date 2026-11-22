import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, reactive, ref } from 'vue';

const mockToast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

const mockNavigateTo = vi.hoisted(() => vi.fn());

vi.mock('~/composables/useToast', () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock('~/composables/useApi', () => ({ useApi: () => ({ api: mockApi }) }));

import JoinPage from '~/pages/join.vue';

const mockAuthUser = ref<{ id: string; username: string; email: string; must_change_password?: boolean } | null>(null);
const mockIsLoggedIn = computed(() => !!mockAuthUser.value);
const mockRoute = reactive({ hash: '' });

const stubs = {
  UCard: { template: '<div><slot /></div>' },
  AdminFormField: { props: ['label', 'hint'], template: '<div><label>{{ label }}</label><slot /></div>' },
  UAlert: { props: ['title', 'color'], template: '<div role="alert">{{ title }}<slot name="description" /></div>' },
  UButton: {
    props: ['loading', 'disabled', 'to'],
    template: '<button :disabled="disabled" :data-to="to"><slot /></button>',
  },
  UInput: {
    props: ['modelValue', 'readonly', 'type', 'placeholder'],
    emits: ['update:modelValue'],
    template:
      '<input :value="modelValue" :type="type || \'text\'" :readonly="readonly" :placeholder="placeholder" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
  NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRoute.hash = '';
  mockAuthUser.value = null;

  vi.stubGlobal('definePageMeta', vi.fn());
  vi.stubGlobal('useSeoMeta', vi.fn());
  vi.stubGlobal('useRoute', () => mockRoute);
  vi.stubGlobal('navigateTo', mockNavigateTo);
  vi.stubGlobal('useRuntimeConfig', () => ({ public: { authCookiePrefix: 'noj' } }));
  vi.stubGlobal('useCookie', () => ref(''));
  vi.stubGlobal('useApi', () => ({ api: mockApi }));
  vi.stubGlobal('useToast', () => ({ toast: mockToast }));
  vi.stubGlobal('useAuth', () => ({
    user: mockAuthUser,
    isLoggedIn: mockIsLoggedIn,
    fetchUser: vi.fn(),
    login: vi.fn(),
  }));
});

describe('pages/join.vue 接受空间与班级邀请页面', () => {
  it('未携带凭据时展示手工输入邀请码表单，支持大小写与连字符短码查询', async () => {
    mockApi.post.mockResolvedValue({
      data: {
        domain_slug: 'demo-domain',
        domain_name: '演示工作空间',
        email: null,
        mode: 'general',
        max_uses: 20,
        used_count: 3,
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        can_register: true,
      },
    });

    const view = mount(JoinPage, { global: { stubs } });
    await flushPromises();

    // 初始状态：展示手工输入框
    expect(view.text()).toContain('邀请码或邀请令牌');
    expect(view.find('input[aria-label="邀请码输入"]').exists()).toBe(true);

    // 输入格式化短码（小写带连字符）
    const input = view.get('input[aria-label="邀请码输入"]');
    await input.setValue('2345-6789-abcd');
    await view.get('form').trigger('submit');
    await flushPromises();

    // 验证以规范化凭据请求
    expect(mockApi.post).toHaveBeenCalledWith(
      '/api/v1/auth/domain-invitation',
      { token: '23456789ABCD' },
      expect.any(Object),
    );

    // 验证展示预览信息
    expect(view.text()).toContain('演示工作空间');
    expect(view.text()).toContain('通用邀请（已使用 3 / 20）');

    // 验证注册按钮（因 can_register 为 true）
    expect(view.text()).toContain('没有账号，注册加入');

    view.unmount();
  });

  it('URL hash 携带凭据时自动加载预览，并根据 can_register=false 提示仅限已有账号', async () => {
    mockRoute.hash = '#token=23456789ABCD';
    mockApi.post.mockResolvedValue({
      data: {
        domain_slug: 'secure-domain',
        domain_name: '受限空间',
        classroom_id: 'c-10',
        classroom_name: '初级算法班',
        email: 'student@example.com',
        mode: 'email',
        max_uses: 1,
        used_count: 0,
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        can_register: false,
      },
    });

    const view = mount(JoinPage, { global: { stubs } });
    await flushPromises();

    expect(mockApi.post).toHaveBeenCalledWith(
      '/api/v1/auth/domain-invitation',
      { token: '23456789ABCD' },
      expect.any(Object),
    );

    expect(view.text()).toContain('接受班级邀请');
    expect(view.text()).toContain('受限空间');
    expect(view.text()).toContain('初级算法班');
    expect(view.text()).toContain('指定邮箱（限 1 人）');
    expect(view.text()).toContain('student@example.com');

    // can_register=false 时不出现注册加入按钮，而是展示限制说明
    expect(view.text()).not.toContain('没有账号，注册加入');
    expect(view.text()).toContain('此实例限制新账号注册（仅管理员开设账号），请使用已有账号登录加入');

    // 点击更换邀请码可返回输入表单
    const resetBtn = view.findAll('button').find((b) => b.text().includes('更换邀请码'))!;
    await resetBtn.trigger('click');
    expect(view.find('input[aria-label="邀请码输入"]').exists()).toBe(true);

    view.unmount();
  });

  it('已登录账号可点击接受邀请，成功后导航至班级或空间路径', async () => {
    mockRoute.hash = '#token=23456789ABCD';
    mockAuthUser.value = {
      id: 'u-1',
      username: 'testuser',
      email: 'student@example.com',
    };

    mockApi.post.mockImplementation((url: string) => {
      if (url === '/api/v1/auth/domain-invitation') {
        return Promise.resolve({
          data: {
            domain_slug: 'school',
            domain_name: '学校空间',
            classroom_id: 'class-abc',
            classroom_name: '高一1班',
            email: 'student@example.com',
            mode: 'email',
            max_uses: 1,
            used_count: 0,
            expires_at: new Date(Date.now() + 86400000).toISOString(),
            can_register: false,
          },
        });
      }
      if (url === '/api/v1/domain-invitations/accept') {
        return Promise.resolve({
          data: {
            domain_slug: 'school',
            classroom_id: 'class-abc',
          },
        });
      }
      return Promise.reject(new Error('Unknown url'));
    });

    const view = mount(JoinPage, { global: { stubs } });
    await flushPromises();

    expect(view.text()).toContain('当前账号：testuser · student@example.com');
    const acceptBtn = view.findAll('button').find((b) => b.text().includes('接受邀请'))!;
    await acceptBtn.trigger('click');
    await flushPromises();

    expect(mockApi.post).toHaveBeenCalledWith(
      '/api/v1/domain-invitations/accept',
      { token: '23456789ABCD' },
      expect.any(Object),
    );
    expect(mockToast.success).toHaveBeenCalledWith('已加入班级与所属空间');
    expect(mockNavigateTo).toHaveBeenCalledWith('/d/school/classrooms/class-abc', { replace: true });

    view.unmount();
  });
});
