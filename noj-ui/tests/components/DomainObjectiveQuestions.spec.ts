import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref, watch } from 'vue';
import DomainObjectiveQuestions from '~/components/editor/DomainObjectiveQuestions.vue';
describe('域客观题草稿', () => {
  it('修改已有小题保持稳定 key，排序不创造新题', async () => {
    vi.stubGlobal('ref', ref);
    vi.stubGlobal('watch', watch);
    const questions = [{
      key: 'stable-question',
      sort_order: 0,
      type: 'single' as const,
      prompt: '旧题面',
      options: [{ key: 'A', text: '选项' }],
      answer: ['A'],
      explanation: '',
    }];
    const view = mount(DomainObjectiveQuestions, {
      props: { modelValue: questions },
      global: {
        stubs: {
          UButton: { template: '<button><slot /></button>' },
          UCard: { template: '<div><slot /></div>' },
          ObjectiveRichText: true,
          ObjectiveQuestionForm: {
            props: ['modelValue'],
            emits: ['update:modelValue', 'save'],
            template:
              "<button @click=\"$emit('update:modelValue', {...modelValue, prompt: '新题面'}); $emit('save', false)\">保存小题</button>",
          },
        },
      },
    });
    await view.findAll('button').find((button) => button.text() === '编辑')!.trigger('click');
    expect(view.emitted('editing')![0]).toEqual([true]);
    await view.findAll('button').find((button) => button.text() === '保存小题')!.trigger('click');
    expect(questions).toHaveLength(1);
    expect(questions[0]!.key).toBe('stable-question');
    expect(questions[0]!.prompt).toBe('新题面');
    expect(view.emitted('editing')!.at(-1)).toEqual([false]);
  });
});
