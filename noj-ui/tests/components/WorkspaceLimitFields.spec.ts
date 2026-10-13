import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import WorkspaceLimitFields from '~/components/workspace/WorkspaceLimitFields.vue';
const stubs = {
  UCheckbox: {
    props: ['modelValue', 'label', 'disabled'],
    emits: ['update:modelValue'],
    template:
      '<label>{{ label }}<input type="checkbox" :disabled="disabled" :checked="modelValue" @change="$emit(\'update:modelValue\', $event.target.checked)" /></label>',
  },
  UInputNumber: {
    props: ['modelValue', 'min', 'max', 'disabled'],
    emits: ['update:modelValue'],
    template:
      '<input type="number" :disabled="disabled" :min="min" :max="max" :value="modelValue" @input="$emit(\'update:modelValue\', Number($event.target.value))" />',
  },
};
describe('四项工作空间额度', () => {
  it('存储与正式提交频率可编辑，0和null保留各自含义并显示实例有效上限', async () => {
    const limits = { members: null, problems: 0, storage_bytes: 274877906944, submissions_per_minute: 30 };
    const caps = { members: 40, problems: 100, storage_bytes: 137438953472, submissions_per_minute: 60 };
    const view = mount(WorkspaceLimitFields, {
      props: { modelValue: limits, caps, effective: { ...caps, problems: 0, submissions_per_minute: 30 } },
      global: { stubs },
    });
    expect(view.text()).toContain('存储');
    expect(view.text()).toContain('每分钟正式提交');
    expect(view.get('input[aria-label="存储上限"]').attributes('max')).toBe(String(Number.MAX_SAFE_INTEGER));
    await view.get('input[aria-label="每分钟正式提交上限"]').setValue('0');
    expect(limits.submissions_per_minute).toBe(0);
    await view.findAll('label').find((label) => label.text() === '存储：不额外限制')!.get('input').setValue(true);
    expect(limits.storage_bytes).toBeNull();
    expect(view.text()).toContain('实例上限：137438953472');
    expect(view.text()).toContain('当前有效上限：0');
  });
  it('归档只读时额度控件不允许写入', () => {
    const view = mount(WorkspaceLimitFields, {
      props: {
        modelValue: { members: null, problems: 0, storage_bytes: null, submissions_per_minute: 0 },
        disabled: true,
      },
      global: { stubs },
    });
    expect(view.findAll('input').every((input) => (input.element as HTMLInputElement).disabled)).toBe(true);
  });
});
