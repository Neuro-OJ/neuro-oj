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
  it('确认期间页面身份或域变化时不应用旧模板', async () => {
    const domain = detail();
    const view = mount(WorkspaceSettingsForm, { props: { domain, modules, canArchive: false }, global: { stubs } });
    api.previewPreset.mockResolvedValue({
      data: { revision: 7, changes: [{ key: 'access', before: 'members', after: 'public' }] },
    });
    await view.findAll('button').find((button) => button.text() === '预览差异')!.trigger('click');
    await flushPromises();
    let resolve!: (confirmed: boolean) => void;
    confirm.mockReturnValue(
      new Promise<boolean>((done) => {
        resolve = done;
      }),
    );
    await view.findAll('button').find((button) => button.text() === '应用这些修改')!.trigger('click');
    domain.slug = 'school-two';
    resolve(true);
    await flushPromises();
    expect(api.applyPreset).not.toHaveBeenCalled();
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
    expect(api.update).toHaveBeenCalledWith('school-one', expect.objectContaining({ name: '尚未保存的修改' }), 7);
    expect((name.element as HTMLInputElement).value).toBe('尚未保存的修改');
    expect(view.get('[role="alert"]').text()).toContain('配置已变化');
    expect(view.emitted('saved')).toBeUndefined();
    view.unmount();
  });
  it('模板先预览差异，确认后才按预览 revision 写入', async () => {
    const view = mount(WorkspaceSettingsForm, {
      props: { domain: detail(), modules, canArchive: false },
      global: { stubs },
    });
    api.previewPreset.mockResolvedValue({
      data: { revision: 9, changes: [{ key: 'access', before: 'members', after: 'public' }] },
    });
    await view.findAll('button').find((button) => button.text() === '预览差异')!.trigger('click');
    await flushPromises();
    expect(view.text()).toContain('访问方式：仅成员 → 公开');
    expect(api.applyPreset).not.toHaveBeenCalled();
    confirm.mockResolvedValueOnce(false);
    const apply = view.findAll('button').find((button) => button.text() === '应用这些修改')!;
    await apply.trigger('click');
    await flushPromises();
    expect(api.applyPreset).not.toHaveBeenCalled();
    confirm.mockResolvedValueOnce(true);
    api.applyPreset.mockResolvedValue({});
    await apply.trigger('click');
    await flushPromises();
    expect(api.applyPreset).toHaveBeenCalledWith('school-one', 'education', 9);
    expect(view.emitted('saved')).toHaveLength(1);
    view.unmount();
  });
});
