import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';

const mockToast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const mockApi = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn() }));
const mockDialog = vi.hoisted(() => ({ confirm: vi.fn() }));

vi.mock('~/composables/useToast', () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock('~/composables/useApi', () => ({ useApi: () => ({ api: mockApi }) }));
vi.mock('~/composables/useDialog', () => ({ useDialog: () => ({ dialog: mockDialog }) }));

import InvitationsPage from '~/pages/d/[slug]/settings/invitations.vue';

const stubs = {
  DomainSettingsShell: {
    template: '<div data-testid="domain-settings-shell"><slot /></div>',
  },
  AdminPageHeader: {
    props: ['title', 'description', 'icon'],
    template: '<div><h1>{{ title }}</h1><p>{{ description }}</p></div>',
  },
  InvitationManager: {
    props: ['domainSlug', 'classroomId', 'writable'],
    template:
      '<div data-testid="invitation-manager" :data-slug="domainSlug" :data-classroom="classroomId" :data-writable="String(writable)" />',
  },
  UAlert: {
    props: ['title', 'color', 'variant'],
    template: '<div role="alert" :data-color="color">{{ title }}</div>',
  },
};

const mockDomain = ref<Record<string, unknown> | null>({
  status: 'active',
  permissions: ['domain:invitations'],
});
const mockStatus = ref<'idle' | 'pending' | 'success' | 'error'>('success');
const mockError = ref<unknown>(null);
const mockCan = vi.fn((perm: string) => {
  if (!mockDomain.value) return false;
  return (mockDomain.value.permissions as string[])?.includes(perm) ?? false;
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('definePageMeta', vi.fn());
  vi.stubGlobal('useSeoMeta', vi.fn());
  vi.stubGlobal('useWorkspace', () => ({
    slug: ref('space-alpha'),
    domain: mockDomain,
    status: mockStatus,
    error: mockError,
    can: mockCan,
  }));

  mockDomain.value = {
    status: 'active',
    permissions: ['domain:invitations'],
  };
  mockStatus.value = 'success';
  mockError.value = null;
});

describe('pages/d/[slug]/settings/invitations.vue', () => {
  it('在活动域且权限与 context.status 均成功时，挂载 InvitationManager 且 writable 为 true', async () => {
    const view = mount(InvitationsPage, { global: { stubs } });
    await flushPromises();

    expect(view.find('[data-testid="domain-settings-shell"]').exists()).toBe(true);
    const inviteMgr = view.find('[data-testid="invitation-manager"]');
    expect(inviteMgr.exists()).toBe(true);
    expect(inviteMgr.attributes('data-slug')).toBe('space-alpha');
    expect(inviteMgr.attributes('data-writable')).toBe('true');
    expect(view.find('[role="alert"]').exists()).toBe(false);

    view.unmount();
  });

  it('用户缺少 domain:invitations 权限时，必须移除 InvitationManager 并展示未授权提示', async () => {
    mockDomain.value = {
      status: 'active',
      permissions: [], // 无 domain:invitations 权限
    };

    const view = mount(InvitationsPage, { global: { stubs } });
    await flushPromises();

    // 组件必须被移除
    expect(view.find('[data-testid="invitation-manager"]').exists()).toBe(false);
    const alert = view.get('[role="alert"]');
    expect(alert.text()).toContain('你没有管理此空间邀请的权限');

    view.unmount();
  });

  it('context 发生 401/403 真实未授权错误时，必须移除组件并展示未授权提示', async () => {
    mockStatus.value = 'error';
    mockError.value = { status: 403, data: { error: 'Forbidden' } };
    mockDomain.value = null;

    const view = mount(InvitationsPage, { global: { stubs } });
    await flushPromises();

    expect(view.find('[data-testid="invitation-manager"]').exists()).toBe(false);
    expect(view.find('[role="alert"]').exists()).toBe(true);
    expect(view.find('[role="alert"]').text()).toContain('你没有管理此空间邀请的权限');

    view.unmount();
  });

  it('域状态非 active 时，InvitationManager 保留但 writable 为 false（只读）', async () => {
    mockDomain.value = {
      status: 'archived',
      permissions: ['domain:invitations'],
    };

    const view = mount(InvitationsPage, { global: { stubs } });
    await flushPromises();

    const inviteMgr = view.find('[data-testid="invitation-manager"]');
    expect(inviteMgr.exists()).toBe(true);
    expect(inviteMgr.attributes('data-writable')).toBe('false');

    view.unmount();
  });

  it('context 发生 500 服务错误时，保留组件且 writable 为 false（只读），并展示服务错误信息', async () => {
    mockStatus.value = 'error';
    mockError.value = { status: 500, data: { error: 'Database connection failed' } };
    mockDomain.value = null;

    const view = mount(InvitationsPage, { global: { stubs } });
    await flushPromises();

    // 服务错误不移除组件，但置为只读
    const inviteMgr = view.find('[data-testid="invitation-manager"]');
    expect(inviteMgr.exists()).toBe(true);
    expect(inviteMgr.attributes('data-writable')).toBe('false');
    expect(view.text()).toContain('Database connection failed');

    view.unmount();
  });
});
