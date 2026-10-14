import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { reactive, ref } from 'vue';
import InstancePolicyForm from '~/components/workspace/InstancePolicyForm.vue';
import { instancePolicyDraft } from '~/utils/instance-governance';
import type { InstanceSetting } from '~/utils/instance-governance';
const saveSetting = vi.fn();
const initial = (): InstanceSetting[] =>
  Object.entries({
    instance_access: 'public',
    instance_registration_mode: 'open',
    domain_creation_policy: 'admin',
    default_domain_slug: 'main',
    domain_creation_limit: 3,
    allow_domain_registration_invites: false,
    instance_allowed_modules: JSON.stringify({ community: true, classroom: true, assignment: true, analytics: true }),
    domain_default_limits: JSON.stringify({
      members: null,
      problems: 0,
      storage_bytes: null,
      submissions_per_minute: null,
    }),
    domain_limit_caps: JSON.stringify({
      members: 100,
      problems: null,
      storage_bytes: 274877906944,
      submissions_per_minute: 30,
    }),
    domain_llm_quota_caps: JSON.stringify({
      day: { max_calls: null, max_tokens: 0, max_cost: 10 },
      month: { max_calls: null, max_tokens: null, max_cost: null },
    }),
  }).map(([key, effective_value]) => ({ key, effective_value, updated_at: '2026-10-13T10:00:00Z', source: 'db' }));
const input = {
  props: ['modelValue'],
  emits: ['update:modelValue'],
  template: '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
};
const stubs = {
  UCard: { template: '<section><slot /></section>' },
  AdminFormField: { template: '<div><slot /></div>' },
  UInput: input,
  UInputNumber: {
    ...input,
    template:
      '<input type="number" :value="modelValue" @input="$emit(\'update:modelValue\', Number($event.target.value))" />',
  },
  USelect: {
    props: ['modelValue', 'items'],
    emits: ['update:modelValue'],
    template:
      '<select :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value)"><option v-for="item in items" :value="item.value">{{ item.label }}</option></select>',
  },
  UCheckbox: {
    props: ['modelValue', 'label'],
    emits: ['update:modelValue'],
    template:
      '<label>{{ label }}<input type="checkbox" :checked="modelValue" @change="$emit(\'update:modelValue\', $event.target.checked)" /></label>',
  },
  UButton: { template: '<button><slot /></button>' },
  WorkspaceLimitFields: { props: ['modelValue'], template: '<div :data-limits="JSON.stringify(modelValue)" />' },
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('reactive', reactive);
  vi.stubGlobal('ref', ref);
  vi.stubGlobal('useInstanceAdmin', () => ({ saveSetting }));
});
describe('实例政策使用现有设置契约', () => {
  it('额度null表示不限、0表示禁止，存储不被32位输入上限截断', () => {
    const draft = instancePolicyDraft(initial());
    expect(draft.domain_default_limits.members).toBeNull();
    expect(draft.domain_default_limits.problems).toBe(0);
    expect(draft.domain_limit_caps.storage_bytes).toBe(274877906944);
  });
  it('冲突保留原设置版本和选择，不刷新其他尚未保存的政策', async () => {
    const settings = initial(), view = mount(InstancePolicyForm, { props: { initial: settings }, global: { stubs } });
    await view.get('select[aria-label="实例访问"]').setValue('authenticated');
    await view.get('input[aria-label="默认工作空间"]').setValue('school');
    saveSetting.mockRejectedValue({ statusCode: 409, data: { error: '设置已变化' } });
    await view.findAll('form')[0]!.trigger('submit');
    await flushPromises();
    expect(saveSetting).toHaveBeenCalledWith(settings[0], 'authenticated');
    expect(view.text()).toContain('设置已变化');
    expect((view.get('input[aria-label="默认工作空间"]').element as HTMLInputElement).value).toBe('school');
    expect((view.get('select[aria-label="实例访问"]').element as HTMLSelectElement).value).toBe('authenticated');
  });
  it('关闭班级时联动关闭作业与学情，保存仍为注册表文本值', async () => {
    const settings = initial(), view = mount(InstancePolicyForm, { props: { initial: settings }, global: { stubs } });
    saveSetting.mockImplementation((setting: InstanceSetting, value: unknown) =>
      Promise.resolve({
        data: { ...setting, effective_value: value },
      })
    );
    await view.findAll('label').find((label) => label.text() === '班级')!.get('input').setValue(false);
    await view.findAll('form').find((form) => form.text().includes('保存模块许可'))!.trigger('submit');
    await flushPromises();
    expect(JSON.parse(saveSetting.mock.calls[0]![1])).toEqual({
      community: true,
      classroom: false,
      assignment: false,
      analytics: false,
    });
    expect(view.text()).toContain('已保存');
  });
});
