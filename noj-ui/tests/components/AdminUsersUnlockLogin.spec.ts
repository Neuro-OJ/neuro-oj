import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, reactive, ref, watch } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import UsersPage from '~/pages/admin/users.vue';

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  load: vi.fn(),
}));
const rows = [
  { id: 'user-uuid', username: 'alice', role: 'user', deleted_at: null },
  { id: 'other-uuid', username: 'bob', role: 'user', deleted_at: null },
  { id: 'deleted-uuid', username: 'deleted', role: 'user', deleted_at: '2026-10-31' },
];

vi.mock('~/composables/useToast', () => ({
  useToast: () => ({ toast: { success: mocks.success, error: mocks.error } }),
}));
vi.mock('~/composables/useAdminList', () => ({
  useAdminList: () => ({
    items: ref(rows),
    totalPages: ref(1),
    currentPage: ref(1),
    load: mocks.load,
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.post.mockResolvedValue({ data: { id: 'user-uuid' } });
  for (const [name, value] of Object.entries({ ref, reactive, computed, watch })) vi.stubGlobal(name, value);
  vi.stubGlobal('definePageMeta', vi.fn());
  vi.stubGlobal('useAuth', () => ({ isLoggedIn: ref(true) }));
  vi.stubGlobal('useRouter', () => ({}));
  vi.stubGlobal('useRequireLogin', vi.fn());
  vi.stubGlobal('useApi', () => ({ api: { post: mocks.post } }));
  vi.stubGlobal('useDialog', () => ({ dialog: {} }));
});
afterEach(() => vi.unstubAllGlobals());

const TableStub = defineComponent({
  props: ['items'],
  setup(props, { slots }) {
    return () =>
      h(
        'div',
        props.items.map((row: typeof rows[number]) => h('section', { 'data-user': row.id }, slots.actions?.({ row }))),
      );
  },
});
const ButtonStub = defineComponent({
  props: ['loading', 'disabled'],
  setup(props, { slots, attrs }) {
    return () => h('button', { ...attrs, disabled: props.disabled, 'aria-busy': !!props.loading }, slots.default?.());
  },
});

function view() {
  return mount(UsersPage, {
    global: {
      stubs: {
        AdminPageHeader: true,
        RefreshControl: true,
        AdminTable: TableStub,
        UButton: ButtonStub,
        AdminEditPanel: true,
        UModal: true,
        UIcon: true,
      },
    },
  });
}

function unlockButton(wrapper: ReturnType<typeof view>, id = 'user-uuid') {
  return wrapper.findAll(`[data-user="${id}"] button`).find((button) => button.text() === '解除登录锁定')!;
}

describe('管理员解除登录锁定', () => {
  it('每个未注销用户都有入口，使用用户 ID 请求并提示成功', async () => {
    const wrapper = view();
    expect(unlockButton(wrapper, 'deleted-uuid')).toBeUndefined();
    await unlockButton(wrapper).trigger('click');
    await flushPromises();
    expect(mocks.post).toHaveBeenCalledWith('/api/v1/admin/identity/users/user-uuid/unlock-login', undefined, {
      silent: true,
    });
    expect(mocks.success).toHaveBeenCalledWith('已解除 alice 的登录锁定');
    expect(mocks.error).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('处理中显示加载并禁用解锁按钮，完成后恢复', async () => {
    let finish!: (value: unknown) => void;
    mocks.post.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const wrapper = view();
    await unlockButton(wrapper).trigger('click');
    expect(unlockButton(wrapper).attributes('aria-busy')).toBe('true');
    expect(unlockButton(wrapper).attributes('disabled')).toBeDefined();
    expect(unlockButton(wrapper, 'other-uuid').attributes('disabled')).toBeDefined();
    await unlockButton(wrapper).trigger('click');
    expect(mocks.post).toHaveBeenCalledOnce();
    finish({ data: {} });
    await flushPromises();
    expect(unlockButton(wrapper).attributes('aria-busy')).toBe('false');
    expect(unlockButton(wrapper).attributes('disabled')).toBeUndefined();
    wrapper.unmount();
  });

  it('请求失败显示后端错误并恢复按钮，可重新操作', async () => {
    mocks.post.mockRejectedValueOnce({ data: { error: '登录限流服务暂时不可用' } });
    const wrapper = view();
    await unlockButton(wrapper).trigger('click');
    await flushPromises();
    expect(mocks.error).toHaveBeenCalledWith('登录限流服务暂时不可用');
    expect(mocks.success).not.toHaveBeenCalled();
    expect(unlockButton(wrapper).attributes('disabled')).toBeUndefined();
    await unlockButton(wrapper).trigger('click');
    await flushPromises();
    expect(mocks.success).toHaveBeenCalledOnce();
    wrapper.unmount();
  });
});
