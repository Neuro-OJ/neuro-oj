import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { reactive, ref } from 'vue';
import type { WorkspaceDetail } from '~/utils/workspace';

const notices = vi.hoisted(() => ({ success: vi.fn() }));
vi.mock('~/composables/useToast', () => ({ useToast: () => ({ toast: notices }) }));
import WorkspaceSettingsForm from '~/components/workspace/WorkspaceSettingsForm.vue';

const api = { update: vi.fn(), previewPreset: vi.fn(), applyPreset: vi.fn(), status: vi.fn() };
const confirm = vi.fn();
const modules = { community: true, classroom: true, assignment: true, analytics: true };
const detail = (): WorkspaceDetail =>
  reactive({
    id: 'school',
    slug: 'school-one',
    name: '原名称',
    description: '',
    status: 'active',
    owner_id: 'owner',
    preset: 'education',
    revision: 7,
    actor_id: 'owner',
    is_member: true,
    platform_admin: false,
    permissions: ['domain:settings'],
    configuration: {
      access: 'members',
      discoverable: false,
      join_policy: 'invite',
      features: { ...modules },
      homepage: 'teaching',
    },
  });
const input = {
  props: ['modelValue'],
  emits: ['update:modelValue'],
  template: '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
};
const stubs = {
  UCard: { template: '<div><slot /></div>' },
  AdminFormField: { template: '<div><slot /></div>' },
  UInput: input,
  UTextarea: {
    ...input,
    template: '<textarea :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
  USelect: { props: ['modelValue'], template: '<select />' },
  UCheckbox: {
    props: ['modelValue', 'label'],
    template: '<label>{{ label }}<input type="checkbox" :checked="modelValue" /></label>',
  },
  UButton: { template: '<button><slot /></button>' },
  NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
  UIcon: { props: ['name'], template: '<i />' },
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('reactive', reactive);
  vi.stubGlobal('ref', ref);
  vi.stubGlobal('useWorkspaceApi', () => api);
  vi.stubGlobal('useUnsavedChanges', vi.fn());
  vi.stubGlobal('useDialog', () => ({ dialog: { confirm } }));
});
describe('空间设置与并发编辑', () => {
  it('默认域没有状态操作时不显示空的空间状态面板', () => {
    const domain = detail();
    domain.slug = 'main';
    const view = mount(WorkspaceSettingsForm, {
      props: { domain, modules, canArchive: true },
      global: { stubs },
    });
    expect(view.text()).not.toContain('空间状态');
    view.unmount();
  });
  it('响应式域对象可打开表单；外部 revision 变化后的冲突保留修改和原编辑依据', async () => {
    const domain = detail();
    const view = mount(WorkspaceSettingsForm, { props: { domain, modules, canArchive: false }, global: { stubs } });
    const name = view.get('input[aria-label="空间名称"]');
    await name.setValue('尚未保存的修改');
    domain.revision = 8;
    expect(domain.name).toBe('原名称');
    api.update.mockRejectedValue({ statusCode: 409, data: { error: '配置已变化', code: 'CONFLICT' } });
    await view.get('form').trigger('submit');
    await flushPromises();
    expect(api.update).toHaveBeenCalledWith('school-one', { name: '尚未保存的修改', description: '' }, 7);
    expect((name.element as HTMLInputElement).value).toBe('尚未保存的修改');
    expect(view.get('[role="alert"]').text()).toContain('配置已变化');
    expect(view.emitted('saved')).toBeUndefined();
    view.unmount();
  });
  it('固定类型只展示说明，表单不提供能力开关或模板重应用', () => {
    const view = mount(WorkspaceSettingsForm, {
      props: { domain: detail(), modules, canArchive: false },
      global: { stubs },
    });
    expect(view.text()).toContain('域类型：教学 · 创建后固定');
    expect(view.text()).not.toContain('重新应用模板');
    expect(view.text()).toContain('访问与加入政策');
    expect(view.find('a[href="/d/school-one/settings/access"]').exists()).toBe(true);
    expect(view.findAll('input[type="checkbox"]')).toHaveLength(0);
    view.unmount();
  });
  it('disabled 为 true 或域非活跃时禁用保存按钮且拦截提交，但草稿可继续编辑', async () => {
    const domain = detail();
    const view = mount(WorkspaceSettingsForm, {
      props: { domain, modules, canArchive: false, disabled: true },
      global: { stubs },
    });
    const submitBtn = view.get('button[type="submit"]');
    expect((submitBtn.element as HTMLButtonElement).disabled).toBe(true);
    const name = view.get('input[aria-label="空间名称"]');
    await name.setValue('草稿编辑测试');
    expect((name.element as HTMLInputElement).value).toBe('草稿编辑测试');
    await view.get('form').trigger('submit');
    await flushPromises();
    expect(api.update).not.toHaveBeenCalled();
    view.unmount();
  });
});
