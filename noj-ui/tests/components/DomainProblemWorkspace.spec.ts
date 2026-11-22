import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, ref } from 'vue';
import Workspace from '~/components/problem/DomainProblemWorkspace.vue';

describe('窄屏做题面板', () => {
  it('往返题面时保留作答实例与输入，桌面两栏均可访问', async () => {
    vi.stubGlobal('ref', ref);
    const answer = defineComponent({
      setup: () => ({ code: ref('') }),
      template: '<textarea v-model="code" aria-label="代码" />',
    });
    const view = mount(Workspace, {
      slots: { statement: '<p>长题面</p>', answer },
      global: { stubs: { UButton: { template: '<button><slot /></button>' } } },
    });
    const original = view.get('textarea').element;
    await view.get('textarea').setValue('int main() {}');
    await view.findAll('button')[1].trigger('click');
    expect(view.get('section[aria-label="作答与自测"]').classes()).not.toContain('hidden');
    await view.findAll('button')[0].trigger('click');
    await view.findAll('button')[1].trigger('click');
    expect(view.get('textarea').element).toBe(original);
    expect((original as HTMLTextAreaElement).value).toBe('int main() {}');
    expect(view.get('section[aria-label="题面与样例"]').classes()).toContain('lg:block');
    view.unmount();
  });
});
