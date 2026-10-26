import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { computed, ref, watch } from 'vue';
import UserMenu from '~/components/layout/UserMenu.vue';
const slug = ref('school'), user = ref<{ id: string; username: string; is_admin: boolean } | null>(null);
const remember = vi.fn(), navigate = vi.fn();
const messageResponse = ref<unknown>({ unread_count: 3 });
const permissions = ref<string[]>([]);
const spaces = [{ id: 's', slug: 'school', name: '学校' }, { id: 't', slug: 'team', name: '团队' }];
const stubs = {
  UDropdownMenu: { name: 'UDropdownMenu', props: ['items'], template: '<div><slot /></div>' },
  UButton: { name: 'UButton', props: ['to'], template: '<button><slot /></button>' },
  UserIdentity: true,
  UIcon: true,
};
beforeEach(() => {
  vi.clearAllMocks();
  slug.value = 'school';
  user.value = { id: 'u', username: 'student', is_admin: false };
  permissions.value = [];
  for (const [name, value] of Object.entries({ computed, ref, watch })) vi.stubGlobal(name, value);
  vi.stubGlobal('useNavigationDomain', () => slug);
  vi.stubGlobal('useOptionalWorkspace', () => ({
    domain: computed(() => ({
      slug: slug.value,
      platform_admin: false,
      permissions: permissions.value,
      configuration: { features: { community: true } },
    })),
    can: () => false,
  }));
  vi.stubGlobal('useRoute', () => ({ fullPath: '/d/school/problems/main:1001?assignment_id=task' }));
  vi.stubGlobal('useAuth', () => ({ user, isLoggedIn: computed(() => !!user.value), logout: vi.fn() }));
  vi.stubGlobal('useWorkspaceApi', () => ({ remember, list: vi.fn() }));
  vi.stubGlobal('useApi', () => ({ api: { get: vi.fn() } }));
  vi.stubGlobal('useDialog', () => ({ dialog: { confirm: vi.fn() } }));
  vi.stubGlobal('usePolling', vi.fn());
  vi.stubGlobal('useAsyncData', () => ({ data: ref({ data: spaces }) }));
  messageResponse.value = { unread_count: 3 };
  vi.stubGlobal(
    'useViewAsyncData',
    (section: string) =>
      section === 'messageUnread' ? { data: messageResponse, refresh: vi.fn() } : { data: ref({ data: spaces }) },
  );
  vi.stubGlobal('navigateTo', navigate);
});
describe('头像菜单中的域导航', () => {
  it('真实未读契约正确显示，刷新失败不崩溃且换账号不沿用旧角标', async () => {
    const view = mount(UserMenu, { global: { stubs } });
    const badge = () =>
      view.getComponent({ name: 'UDropdownMenu' }).props('items').flat().find((item: { label: string }) =>
        item.label === '消息'
      ).badge;
    expect(badge()).toBe(3);
    messageResponse.value = undefined;
    await view.vm.$nextTick();
    expect(badge()).toBe(3);
    user.value = { id: 'other', username: 'other', is_admin: false };
    await view.vm.$nextTick();
    expect(badge()).toBeUndefined();
    messageResponse.value = { unread_count: 1 };
    await view.vm.$nextTick();
    expect(badge()).toBe(1);
    view.unmount();
  });
  it('当前域写入用户名和业务链接，不提供跨域汇总入口', async () => {
    const view = mount(UserMenu, { global: { stubs } });
    expect(view.text()).toContain('student@school');
    let items = view.getComponent({ name: 'UDropdownMenu' }).props('items').flat();
    expect(items.find((item: { label: string }) => item.label === '提交').to).toBe('/d/school/submissions');
    expect(JSON.stringify(items)).not.toContain('/my/submissions');
    expect(items.some((item: { label: string }) => item.label === '我的题目')).toBe(false);
    slug.value = 'team';
    await view.vm.$nextTick();
    items = view.getComponent({ name: 'UDropdownMenu' }).props('items').flat();
    expect(view.text()).toContain('student@team');
    expect(items.find((item: { label: string }) => item.label === '提交').to).toBe('/d/team/submissions');
  });
  it('二级菜单明确选择目标域后跳转，不修改当前资源的来源题号', async () => {
    const view = mount(UserMenu, { global: { stubs } });
    const items = view.getComponent({ name: 'UDropdownMenu' }).props('items').flat();
    const domains = items.find((item: { label: string }) => item.label === '切换域').children;
    await domains[1].onSelect();
    expect(remember).toHaveBeenCalledWith('team');
    expect(navigate).toHaveBeenCalledWith('/d/team');
  });
  it('游客登录入口保留题目路径和作业来源参数', () => {
    user.value = null;
    const view = mount(UserMenu, { global: { stubs } });
    expect(view.findAllComponents({ name: 'UButton' })[0]!.props('to')).toEqual({
      path: '/login',
      query: { redirect: '/d/school/problems/main:1001?assignment_id=task' },
    });
  });
  it('域管理员从独立设置按钮进入当前域，成员不显示该按钮', async () => {
    const view = mount(UserMenu, { global: { stubs } });
    const items = () => view.getComponent({ name: 'UDropdownMenu' }).props('items').flat();
    expect(items().some((item: { label: string }) => item.label === '域设置')).toBe(false);
    permissions.value = ['domain:settings'];
    await view.vm.$nextTick();
    expect(items().find((item: { label: string }) => item.label === '域设置').to).toBe('/d/school/settings');
    slug.value = 'main';
    await view.vm.$nextTick();
    expect(items().find((item: { label: string }) => item.label === '域设置').to).toBe('/d/main/settings');
    view.unmount();
  });
});
