import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, ref, watch } from 'vue';

const notices = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('~/composables/useToast', () => ({ useToast: () => ({ toast: notices }) }));
import SystemSettings from '~/pages/admin/settings.vue';

const api = { get: vi.fn(), put: vi.fn(), delete: vi.fn() };
const dialog = { confirm: vi.fn(), alert: vi.fn() };
const guard = vi.fn();
const settings = [
  { key: 'alpha', description: '第一项认证配置', category: 'auth', effective_value: 'initial-alpha' },
  { key: 'beta', description: '第二项邮件配置', category: 'email', effective_value: 'initial-beta' },
].map((item) => ({
  ...item,
  type: 'string',
  scope: 'runtime',
  source: 'db',
  is_secret: false,
  raw_value: item.effective_value,
  updated_at: '2026-10-16T00:00:00Z',
  updated_by: 'admin',
  env_present: true,
  conflict: true,
}));
const stubs = {
  AdminPageHeader: { template: '<header><slot name="actions" /></header>' },
  AsyncContent: { template: '<section><slot /></section>' },
  UButton: { props: ['disabled'], template: '<button :disabled="disabled"><slot /></button>' },
  UIcon: { template: '<i />' },
  UInput: {
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template: '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
  UTextarea: {
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template: '<textarea :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
  USwitch: {
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template:
      '<input type="checkbox" :checked="modelValue" @change="$emit(\'update:modelValue\', $event.target.checked)" />',
  },
  USelect: {
    props: ['modelValue', 'items'],
    emits: ['update:modelValue'],
    template:
      '<select :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value)"><option v-for="item in items" :value="item.value">{{ item.label }}</option></select>',
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  for (const [name, value] of Object.entries({ computed, ref, watch })) vi.stubGlobal(name, value);
  vi.stubGlobal('definePageMeta', vi.fn());
  vi.stubGlobal('useSeoMeta', vi.fn());
  vi.stubGlobal('useRequireLogin', vi.fn());
  vi.stubGlobal('useAuth', () => ({ isLoggedIn: ref(true) }));
  vi.stubGlobal('useApi', () => ({ api }));
  vi.stubGlobal('useDialog', () => ({ dialog }));
  vi.stubGlobal('useUnsavedChanges', guard);
  api.get.mockImplementation((path: string) => {
    if (path === '/api/v1/admin/system/settings') {
      return Promise.resolve({ data: settings.map((item) => ({ ...item })) });
    }
    return Promise.reject(new Error('可选状态未配置'));
  });
  dialog.confirm.mockResolvedValue(true);
});

describe('系统设置草稿与来源', () => {
  it('重置准确提示环境回退且只刷新目标设置，保留其他项目草稿', async () => {
    const view = mount(SystemSettings, { global: { stubs } });
    await flushPromises();
    const beta = view.get('input[id="setting-input-beta-desktop"]');
    await beta.setValue('kept-during-reset');
    api.delete.mockResolvedValue({});
    api.get.mockResolvedValueOnce({
      data: [
        { ...settings[0], source: 'env', effective_value: 'env-alpha', raw_value: 'env-alpha' },
        settings[1],
      ],
    });
    await view.findAll('button[aria-label="重置 alpha"]')[0].trigger('click');
    await flushPromises();
    expect(dialog.confirm).toHaveBeenCalledWith(
      expect.stringContaining('环境变量'),
      expect.objectContaining({ danger: true }),
    );
    expect(api.delete).toHaveBeenCalledWith('/api/v1/admin/system/settings/alpha', {
      silent: true,
      headers: { 'If-Match': '"2026-10-16T00:00:00Z"' },
    });
    expect((view.get('input[id="setting-input-alpha-desktop"]').element as HTMLInputElement).value).toBe('env-alpha');
    expect((beta.element as HTMLInputElement).value).toBe('kept-during-reset');
    view.unmount();
  });

  it('环境变量当前生效时不错误宣称数据库值已经生效', async () => {
    api.get.mockImplementation((path: string) =>
      path === '/api/v1/admin/system/settings'
        ? Promise.resolve({ data: settings.map((item) => ({ ...item, source: 'env', conflict: false })) })
        : Promise.reject(new Error('可选状态未配置'))
    );
    const view = mount(SystemSettings, { global: { stubs } });
    await flushPromises();
    expect(view.text()).toContain('当前使用环境变量兜底');
    expect(view.text()).not.toContain('当前使用数据库值');
    view.unmount();
  });

  it('保存和放弃单项只更新对应草稿，其他未保存修改继续受离开保护', async () => {
    const view = mount(SystemSettings, { global: { stubs } });
    await flushPromises();
    expect(dialog.alert).not.toHaveBeenCalled();
    const dirty = guard.mock.calls[0][0] as () => boolean;
    expect(dirty()).toBe(false);
    const alpha = view.get('input[id="setting-input-alpha-desktop"]');
    const beta = view.get('input[id="setting-input-beta-desktop"]');
    await alpha.setValue('edited-alpha');
    await beta.setValue('edited-beta');
    expect(dirty()).toBe(true);
    api.put.mockResolvedValue({ data: { ...settings[0], effective_value: 'edited-alpha', raw_value: 'edited-alpha' } });
    await view.findAll('button[aria-label="保存 alpha"]')[0].trigger('click');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/api/v1/admin/system/settings/alpha', { value: 'edited-alpha' }, {
      silent: true,
      headers: { 'If-Match': '"2026-10-16T00:00:00Z"' },
    });
    expect((beta.element as HTMLInputElement).value).toBe('edited-beta');
    expect(dirty()).toBe(true);
    await view.findAll('button[aria-label="放弃 beta 的修改"]')[0].trigger('click');
    expect((beta.element as HTMLInputElement).value).toBe('initial-beta');
    expect(dirty()).toBe(false);
    view.unmount();
  });

  it('取消重新读取或加载失败都保留草稿，成功重读后同步输入与基线', async () => {
    const view = mount(SystemSettings, { global: { stubs } });
    await flushPromises();
    const dirty = guard.mock.calls[0][0] as () => boolean;
    const alpha = view.get('input[id="setting-input-alpha-desktop"]');
    await alpha.setValue('local-draft');
    const reload = view.findAll('button').find((button) => button.text() === '重新读取配置')!;
    const before = api.get.mock.calls.length;
    dialog.confirm.mockResolvedValueOnce(false);
    await reload.trigger('click');
    await flushPromises();
    expect(api.get).toHaveBeenCalledTimes(before);
    expect((alpha.element as HTMLInputElement).value).toBe('local-draft');
    api.get.mockRejectedValueOnce(new Error('临时不可用'));
    await reload.trigger('click');
    await flushPromises();
    expect(dirty()).toBe(true);
    expect((alpha.element as HTMLInputElement).value).toBe('local-draft');
    await reload.trigger('click');
    await flushPromises();
    expect((alpha.element as HTMLInputElement).value).toBe('initial-alpha');
    expect(dirty()).toBe(false);
    view.unmount();
  });

  it('搜索和分类只影响展示，不清除被过滤项目的草稿', async () => {
    const view = mount(SystemSettings, { global: { stubs } });
    await flushPromises();
    await view.get('input[id="setting-input-beta-desktop"]').setValue('kept-beta');
    const search = view.get('input[aria-label="搜索设置项"]');
    await search.setValue('认证');
    expect(view.find('input[id="setting-input-beta-desktop"]').exists()).toBe(false);
    await search.setValue('');
    expect((view.get('input[id="setting-input-beta-desktop"]').element as HTMLInputElement).value).toBe('kept-beta');
    const ids = view.findAll('[id]').map((node) => node.attributes('id'));
    expect(new Set(ids).size).toBe(ids.length);
    view.unmount();
  });
});
