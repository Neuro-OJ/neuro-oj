import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import TextInput from '~/components/form/TextInput.vue';
import PasswordField from '~/components/form/PasswordField.vue';
vi.stubGlobal('ref', ref);
const stubs = {
  UFormField: { name: 'UFormField', props: ['error'], template: '<div><slot /></div>' },
  UInput: { template: '<input />' },
};
for (const [name, component] of Object.entries({ TextInput, PasswordField })) {
  describe(`${name} 的默认与错误状态`, () => {
    it('空错误使用中性状态，校验错误原样显示，修正后恢复', async () => {
      const view = mount(component, {
        props: {
          id: 'field',
          label: '字段',
          modelValue: '',
          placeholder: '',
          autocomplete: 'off',
          disabled: false,
          error: '',
        },
        global: { stubs },
      });
      const field = () => view.getComponent({ name: 'UFormField' });
      expect(field().props('error')).toBeUndefined();
      await view.setProps({ error: '请输入内容' });
      expect(field().props('error')).toBe('请输入内容');
      await view.setProps({ error: '' });
      expect(field().props('error')).toBeUndefined();
    });
  });
}
