import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { reactive, ref } from 'vue';

const mockToast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));

const mockDialog = vi.hoisted(() => ({
  confirm: vi.fn(),
}));

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('~/composables/useToast', () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock('~/composables/useDialog', () => ({ useDialog: () => ({ dialog: mockDialog }) }));
vi.mock('~/composables/useApi', () => ({ useApi: () => ({ api: mockApi }) }));

import InvitationManager from '~/components/workspace/InvitationManager.vue';

const stubs = {
  UCard: { template: '<div><slot /></div>' },
  AdminFormField: { props: ['label', 'hint'], template: '<div><slot /></div>' },
  UAlert: { props: ['title', 'color'], template: '<div role="alert">{{ title }}</div>' },
  UIcon: { props: ['name'], template: '<i />' },
  UBadge: { template: '<span><slot /></span>' },
  UButton: {
    props: ['loading', 'disabled'],
    template: '<button :disabled="disabled"><slot /></button>',
  },
  UInput: {
    props: ['modelValue', 'readonly', 'type', 'placeholder'],
    emits: ['update:modelValue'],
    template:
      '<input :value="modelValue" :type="type || \'text\'" :readonly="readonly" :placeholder="placeholder" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
  AdminTable: {
    props: ['columns', 'items', 'loading', 'error', 'currentPage', 'totalPages', 'totalItems'],
    emits: ['update:page'],
    template: `
      <div>
        <div v-if="loading">加载中...</div>
        <div v-else-if="error">{{ error }}</div>
        <table v-else>
          <tbody>
            <tr v-for="item in items" :key="item.id">
              <td v-for="col in columns" :key="col.key">
                <slot v-if="col.key === 'actions'" name="actions" :row="item" />
                <slot v-else name="cell" :row="item" :column="col">
                  {{ item[col.key] }}
                </slot>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    `,
  },
};

const sampleInvitations = [
  {
    id: 'inv-1',
    classroom_id: null,
    mode: 'general',
    email: null,
    max_uses: null,
    used_count: 5,
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    used_at: new Date().toISOString(),
    revoked_at: null,
    created_at: new Date().toISOString(),
  },
  {
    id: 'inv-2',
    classroom_id: null,
    mode: 'email',
    email: 'alice@example.com',
    max_uses: 1,
    used_count: 0,
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    used_at: null,
    revoked_at: null,
    created_at: new Date().toISOString(),
  },
  {
    id: 'inv-3',
    classroom_id: null,
    mode: 'once',
    email: null,
    max_uses: 1,
    used_count: 1,
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    used_at: new Date().toISOString(),
    revoked_at: null,
    created_at: new Date().toISOString(),
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('reactive', reactive);
  vi.stubGlobal('ref', ref);
  mockApi.get.mockResolvedValue({
    data: sampleInvitations,
    pagination: { page: 1, per_page: 25, total: 3, total_pages: 1 },
  });
});

describe('InvitationManager 邀请管理组件', () => {
  it('只读模式（writable=false）不展示创建表单，列表中不展示撤销按钮', async () => {
    const view = mount(InvitationManager, {
      props: { domainSlug: 'cyber-arena', writable: false },
      global: { stubs },
    });
    await flushPromises();

    expect(mockApi.get).toHaveBeenCalledWith('/api/v1/domains/cyber-arena/invitations', expect.any(Object));
    expect(view.text()).not.toContain('创建新邀请');
    expect(view.text()).toContain('已有邀请');
    expect(view.text()).toContain('alice@example.com');
    // 没有撤销按钮
    expect(view.findAll('button').filter((b) => b.text() === '撤销')).toHaveLength(0);
    view.unmount();
  });

  it('可写模式下支持班级上下文，切换模式并校验必填邮箱与人数限制', async () => {
    const view = mount(InvitationManager, {
      props: { domainSlug: 'school', classroomId: 'class-99', writable: true },
      global: { stubs },
    });
    await flushPromises();

    expect(mockApi.get).toHaveBeenCalledWith(
      '/api/v1/domains/school/classrooms/class-99/invitations',
      expect.any(Object),
    );
    expect(view.text()).toContain('创建新邀请');

    // 切换到指定邮箱模式，未输入邮箱时校验报错
    const emailModeBtn = view.findAll('button').find((b) => b.text().includes('指定邮箱'))!;
    expect(emailModeBtn.attributes('aria-pressed')).toBe('false');
    await emailModeBtn.trigger('click');
    expect(emailModeBtn.attributes('aria-pressed')).toBe('true');
    await view.get('form').trigger('submit');
    expect(view.text()).toContain('请输入合法的邮箱地址');

    // 输入非法邮箱
    const emailInput = view.get('input[aria-label="受邀人邮箱"]');
    await emailInput.setValue('not-an-email');
    await view.get('form').trigger('submit');
    expect(view.text()).toContain('请输入合法的邮箱地址');

    // 切换到通用邀请模式并选择限制人数，未填正整数时报错
    const generalModeBtn = view.findAll('button').find((b) => b.text().includes('通用邀请'))!;
    await generalModeBtn.trigger('click');
    expect(generalModeBtn.attributes('aria-pressed')).toBe('true');
    expect(emailModeBtn.attributes('aria-pressed')).toBe('false');
    const limitRadio = view.findAll('input[type="radio"]').find((r) =>
      (r.element as HTMLInputElement).value === 'limit'
    )!;
    await limitRadio.setChecked();
    const maxUsesInput = view.get('input[aria-label="最大使用人数"]');
    await maxUsesInput.setValue('0');
    await view.get('form').trigger('submit');
    expect(view.text()).toContain('使用人数限制须为正整数');

    view.unmount();
  });

  it('成功创建邀请后仅一次性展示凭据与短码，并可手动关闭', async () => {
    const token72 = '12345678-1234-1234-1234-123456789abc12345678-1234-1234-1234-123456789abc';
    mockApi.post.mockResolvedValue({
      data: {
        id: 'new-inv-1',
        token: token72,
        code: '2345-6789-ABCD',
        mode: 'general',
        max_uses: null,
        expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
      },
    });

    const view = mount(InvitationManager, {
      props: { domainSlug: 'school', writable: true },
      global: { stubs },
    });
    await flushPromises();

    // 提交创建
    await view.get('form').trigger('submit');
    await flushPromises();

    expect(mockApi.post).toHaveBeenCalledWith(
      '/api/v1/domains/school/invitations',
      expect.objectContaining({ mode: 'general', max_uses: null }),
      expect.any(Object),
    );
    expect(mockToast.success).toHaveBeenCalledWith('邀请创建成功');

    // 检查凭据提示面板
    expect(view.text()).toContain('邀请凭据已生成');
    expect(view.text()).toContain('完整凭据仅在此展示一次');
    const tokenInput = view.get('input[aria-label="生成的邀请链接"]');
    expect((tokenInput.element as HTMLInputElement).value).toContain('#token=');
    const codeInput = view.get('input[aria-label="生成的邀请短码"]');
    expect((codeInput.element as HTMLInputElement).value).toBe('2345-6789-ABCD');

    // 关闭凭据提示
    const closeBtn = view.findAll('button').find((b) => b.text().includes('已保存，关闭提示'))!;
    await closeBtn.trigger('click');
    expect(view.text()).not.toContain('邀请凭据已生成');

    view.unmount();
  });

  it('撤销操作需二次确认并调用 DELETE 端点刷新列表', async () => {
    mockDialog.confirm.mockResolvedValue(true);
    mockApi.delete.mockResolvedValue({ data: { success: true } });

    const view = mount(InvitationManager, {
      props: { domainSlug: 'school', writable: true },
      global: { stubs },
    });
    await flushPromises();

    // 找到有效邀请的撤销按钮
    const revokeButtons = view.findAll('button').filter((b) => b.text() === '撤销');
    expect(revokeButtons.length).toBeGreaterThan(0);
    await revokeButtons[0].trigger('click');

    expect(mockDialog.confirm).toHaveBeenCalledWith(
      expect.stringContaining('确定要撤销此邀请吗'),
      expect.objectContaining({ danger: true }),
    );
    expect(mockApi.delete).toHaveBeenCalledWith('/api/v1/domains/school/invitations/inv-1', expect.any(Object));
    expect(mockToast.success).toHaveBeenCalledWith('已撤销邀请');

    view.unmount();
  });
});
