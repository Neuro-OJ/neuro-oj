import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, reactive, ref, Suspense, watch } from 'vue';

const mockToast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const mockWorkspaces = vi.hoisted(() => ({
  list: vi.fn(),
  instance: vi.fn(),
  create: vi.fn(),
  requestCreation: vi.fn(),
  remember: vi.fn(),
}));

vi.mock('~/composables/useToast', () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock('~/composables/useWorkspaceApi', () => ({ useWorkspaceApi: () => mockWorkspaces }));

import WorkspacesPage from '~/pages/workspaces.vue';

const stubs = {
  AdminPageHeader: {
    props: ['title', 'description', 'icon'],
    template: `
      <div>
        <h1>{{ title }}</h1>
        <p>{{ description }}</p>
        <div data-testid="header-actions">
          <slot name="actions" />
        </div>
      </div>
    `,
  },
  AsyncContent: {
    props: ['status', 'error'],
    template: '<div><slot /></div>',
  },
  UCard: {
    template: '<div><slot /></div>',
  },
  UButton: {
    props: ['disabled', 'to', 'icon', 'variant', 'color', 'loading'],
    template:
      '<button :disabled="disabled" :data-to="to" :data-icon="icon" :data-variant="variant" :data-color="color"><slot /></button>',
  },
  UModal: {
    props: ['open', 'title'],
    template: '<div v-if="open"><h2>{{ title }}</h2><slot name="body" /></div>',
  },
  AdminFormField: {
    props: ['label'],
    template: '<div><label>{{ label }}</label><slot /></div>',
  },
  UInput: {
    props: ['modelValue'],
    template: '<input :value="modelValue" />',
  },
  USelect: {
    template: '<select />',
  },
  UTextarea: {
    template: '<textarea />',
  },
};

const mockUser = ref<{ id: string; username: string; is_admin: boolean } | null>(null);

beforeEach(() => {
  vi.clearAllMocks();
  for (const [name, value] of Object.entries({ computed, ref, reactive, watch })) {
    vi.stubGlobal(name, value);
  }
  vi.stubGlobal('definePageMeta', vi.fn());
  vi.stubGlobal('useSeoMeta', vi.fn());
  vi.stubGlobal('useAuth', () => ({ user: mockUser }));
  vi.stubGlobal('useWorkspaceApi', () => mockWorkspaces);
  vi.stubGlobal('navigateTo', vi.fn());

  vi.stubGlobal('useAsyncData', async (_key: unknown, handler: () => Promise<unknown>) => {
    const data = ref<unknown>(null);
    const error = ref<unknown>(null);
    try {
      data.value = await handler();
    } catch (e) {
      error.value = e;
    }
    return { data, status: ref('success'), error, refresh: vi.fn() };
  });

  mockWorkspaces.list.mockImplementation((mine = false) => {
    if (mine) {
      return Promise.resolve({
        data: [{ id: 'space-1', slug: 'my-arena', name: '我的竞赛空间', description: '私人训练' }],
      });
    }
    return Promise.resolve({
      data: [{ id: 'space-2', slug: 'public-arena', name: '公开竞赛空间', description: '人人可进' }],
    });
  });

  mockWorkspaces.instance.mockResolvedValue({
    data: {
      access: 'public',
      default_domain_slug: 'default',
      domain_creation_policy: 'open',
      modules: { community: true, classroom: true, assignment: true, analytics: true },
    },
  });
});

describe('pages/workspaces.vue 空间列表页', () => {
  it('页头包含明显的“输入邀请码”普通按钮并指向 /join', async () => {
    mockUser.value = { id: 'u-1', username: 'alice', is_admin: false };

    const Wrapper = defineComponent({
      setup: () => () => h(Suspense, null, { default: () => h(WorkspacesPage) }),
    });
    const view = mount(Wrapper, { global: { stubs } });
    await flushPromises();

    // 检查页头 actions 区域
    const actions = view.get('[data-testid="header-actions"]');
    const buttons = actions.findAll('button');
    const joinBtn = buttons.find((b) => b.text().includes('输入邀请码'));

    expect(joinBtn).toBeDefined();
    expect(joinBtn!.attributes('data-to')).toBe('/join');
    expect(joinBtn!.attributes('data-variant')).toBe('outline');
    expect(joinBtn!.attributes('data-icon')).toBe('i-lucide-key-round');

    view.unmount();
  });

  it('未登录用户同样能清晰看到“输入邀请码”入口', async () => {
    mockUser.value = null;

    const Wrapper = defineComponent({
      setup: () => () => h(Suspense, null, { default: () => h(WorkspacesPage) }),
    });
    const view = mount(Wrapper, { global: { stubs } });
    await flushPromises();

    const actions = view.get('[data-testid="header-actions"]');
    const joinBtn = actions.findAll('button').find((b) => b.text().includes('输入邀请码'));

    expect(joinBtn).toBeDefined();
    expect(joinBtn!.attributes('data-to')).toBe('/join');
    // 未登录用户不展示创建空间按钮
    expect(actions.text()).not.toContain('创建空间');

    view.unmount();
  });

  it('展示我的空间与发现空间列表', async () => {
    mockUser.value = { id: 'u-1', username: 'alice', is_admin: false };

    const Wrapper = defineComponent({
      setup: () => () => h(Suspense, null, { default: () => h(WorkspacesPage) }),
    });
    const view = mount(Wrapper, { global: { stubs } });
    await flushPromises();

    expect(view.text()).toContain('我的空间');
    expect(view.text()).toContain('我的竞赛空间');
    expect(view.text()).toContain('发现空间');
    expect(view.text()).toContain('公开竞赛空间');

    view.unmount();
  });
});
