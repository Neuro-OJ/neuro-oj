import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import WorkspaceLimitFields from '~/components/workspace/WorkspaceLimitFields.vue';

const stubs = {
  USelect: {
    props: ['modelValue', 'items', 'disabled', 'ariaLabel'],
    emits: ['update:modelValue'],
    template:
      '<select :disabled="disabled" :aria-label="ariaLabel" :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value)"><option v-for="item in items" :key="item.value" :value="item.value">{{ item.label }}</option></select>',
  },
  UInput: {
    props: ['modelValue', 'min', 'max', 'disabled', 'ariaLabel', 'type', 'inputmode', 'step'],
    emits: ['update:modelValue'],
    template:
      '<input :type="type || \'text\'" :inputmode="inputmode" :step="step" :disabled="disabled" :aria-label="ariaLabel" :min="min" :max="max" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
  UButton: { template: '<button><slot /></button>' },
};

describe('四项工作空间额度', () => {
  it('精确字节经过显示、单位切换和回切不改变实际提交值', async () => {
    const precise = 1073741825;
    const limits = { members: null, problems: null, storage_bytes: precise, submissions_per_minute: null };
    const view = mount(WorkspaceLimitFields, { props: { modelValue: limits }, global: { stubs } });
    const storage = view.get('input[aria-label="存储上限"]');
    const unit = view.get('select[aria-label="存储单位"]');
    expect((storage.element as HTMLInputElement).value).toBe(String(precise));
    expect((unit.element as HTMLSelectElement).value).toBe('bytes');
    await unit.setValue('gib');
    expect(limits.storage_bytes).toBe(precise);
    // 不可精确表达时可以给出提示，但不能自动把原额度舍入到整GiB。
    await unit.setValue('bytes');
    expect((storage.element as HTMLInputElement).value).toBe(String(precise));
    expect(limits.storage_bytes).toBe(precise);
    expect(view.emitted('valid')?.slice(-1)[0]).toEqual([true]);
    await storage.setValue(String(Number.MAX_SAFE_INTEGER + 1));
    expect(view.emitted('valid')?.slice(-1)[0]).toEqual([false]);
    expect(limits.storage_bytes).toBe(precise);
    view.unmount();
  });

  it('编辑其他字段不会把尚未填完的自定义额度静默恢复为继承', async () => {
    const limits = { members: null, problems: null, storage_bytes: null, submissions_per_minute: null };
    const view = mount(WorkspaceLimitFields, { props: { modelValue: limits }, global: { stubs } });
    await view.get('select[aria-label="成员额度模式"]').setValue('custom');
    await view.get('select[aria-label="每分钟正式提交额度模式"]').setValue('custom');
    await view.get('input[aria-label="每分钟正式提交上限"]').setValue('30');
    expect((view.get('select[aria-label="成员额度模式"]').element as HTMLSelectElement).value).toBe('custom');
    expect(view.get('input[aria-label="成员上限"]').exists()).toBe(true);
    expect(view.emitted('valid')?.slice(-1)[0]).toEqual([false]);
    view.unmount();
  });

  it('重新读取替换配置后同步可见输入与基线，未修改时不显示预计变化', async () => {
    const limits = { members: 20, problems: null, storage_bytes: null, submissions_per_minute: null };
    const view = mount(WorkspaceLimitFields, { props: { modelValue: limits }, global: { stubs } });
    expect(view.text()).not.toContain('保存后预计生效：');
    await view.get('input[aria-label="成员上限"]').setValue('30');
    expect(view.text()).toContain('保存后预计生效：');
    await view.setProps({ modelValue: { ...limits, members: 40 } });
    expect((view.get('input[aria-label="成员上限"]').element as HTMLInputElement).value).toBe('40');
    expect(view.text()).not.toContain('保存后预计生效：');
    view.unmount();
  });

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
    await view.get('select[aria-label="存储额度模式"]').setValue('inherit');
    expect(limits.storage_bytes).toBeNull();
    expect(view.text()).toContain('实例上限：');
    expect(view.text()).toContain('当前已保存有效值：');
    expect(view.text()).toContain('保存后预计生效：');
  });

  it('自定义模式空值显示待填写且触发有效性通知，输入数值无需blur立即valid=true，小数报错不静默取整', async () => {
    const limits = { members: null, problems: null, storage_bytes: null, submissions_per_minute: null };
    const view = mount(WorkspaceLimitFields, {
      props: { modelValue: limits },
      global: { stubs },
    });
    await view.get('select[aria-label="成员额度模式"]').setValue('custom');
    expect(view.text()).toContain('待填写');
    expect(view.emitted('valid')?.slice(-1)[0]).toEqual([false]);

    const input = view.get('input[aria-label="成员上限"]');

    // 小数输入报错，不允许静默 Math.floor
    await input.setValue('1.5');
    expect(view.text()).toContain('成员上限必须为整数');
    expect(view.emitted('valid')?.slice(-1)[0]).toEqual([false]);

    // 输入正整数无需 blur 即可立即触发 valid=true 并同步 model
    await input.setValue('40');
    expect(limits.members).toBe(40);
    expect(view.emitted('valid')?.slice(-1)[0]).toEqual([true]);
    expect(view.text()).toContain('40 人');
  });

  it('归档只读时额度控件不允许写入', () => {
    const view = mount(WorkspaceLimitFields, {
      props: {
        modelValue: { members: null, problems: 0, storage_bytes: null, submissions_per_minute: 0 },
        disabled: true,
      },
      global: { stubs },
    });
    expect(view.findAll('select, input').every((el) => (el.element as HTMLInputElement).disabled)).toBe(true);
  });
});
