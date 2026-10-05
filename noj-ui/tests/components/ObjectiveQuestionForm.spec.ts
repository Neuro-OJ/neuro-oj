import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick, ref, watch } from 'vue';
import ObjectiveQuestionForm from '~/components/objective/ObjectiveQuestionForm.vue';
import type { QuestionDraft } from '~/composables/useObjective';

// 组件测试环境没有 Nuxt 自动导入
Object.assign(globalThis, { ref, watch });

/** Nuxt UI 组件桩：按钮渲染为 button，文本框渲染为 textarea 并支持 v-model */
const stubs = {
  UButton: {
    emits: ['click'],
    template: '<button type="button" v-bind="$attrs" @click="$emit(\'click\')"><slot /></button>',
  },
  UTextarea: {
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template: '<textarea :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
  UFormField: { props: ['label'], template: '<div><slot /></div>' },
  USwitch: { template: '<span />' },
  ObjectiveRichText: { props: ['content'], template: '<div class="rich">{{ content }}</div>' },
};

function draft(overrides: Partial<QuestionDraft> = {}): QuestionDraft {
  return {
    id: null,
    type: 'multiple',
    prompt: '题干',
    options: ['A', 'B', 'C', 'D'].map((key) => ({ key, text: `选项${key}` })),
    answer: [],
    explanation: '',
    ...overrides,
  };
}

function mountForm(value: QuestionDraft) {
  const model = ref(value);
  const wrapper = mount(ObjectiveQuestionForm, {
    props: {
      modelValue: model.value,
      'onUpdate:modelValue': (v: QuestionDraft) => (model.value = v),
      saving: false,
    },
    global: { stubs },
  });
  return { wrapper, model };
}

describe('ObjectiveQuestionForm', () => {
  it('删除选项后按顺序重排键名并迁移已选答案', async () => {
    const { wrapper, model } = mountForm(draft({ answer: ['A', 'C', 'D'] }));
    await wrapper.find('[aria-label="删除选项 B"]').trigger('click');

    expect(model.value.options).toEqual([
      { key: 'A', text: '选项A' },
      { key: 'B', text: '选项C' },
      { key: 'C', text: '选项D' },
    ]);
    // 原 C / D 随之变为 B / C，原 A 不变
    expect([...model.value.answer].sort()).toEqual(['A', 'B', 'C']);
  });

  it('删除已选为答案的选项时同时移除该答案', async () => {
    const { wrapper, model } = mountForm(draft({ type: 'single', answer: ['B'] }));
    await wrapper.find('[aria-label="删除选项 B"]').trigger('click');
    expect(model.value.answer).toEqual([]);
  });

  it('切换题型时清空旧答案', async () => {
    const value = draft({ answer: ['A', 'B'] });
    const { wrapper, model } = mountForm(value);
    const judgeButton = wrapper.findAll('button').find((b) => b.text() === '判断');
    await judgeButton!.trigger('click');
    await nextTick();
    expect(model.value.type).toBe('judge');
    expect(model.value.answer).toEqual([]);
  });

  it('单选题勾选另一个选项时替换答案', async () => {
    const { wrapper, model } = mountForm(draft({ type: 'single', answer: ['A'] }));
    const radios = wrapper.findAll('input[type="radio"]');
    await radios[2]!.setValue(true);
    expect(model.value.answer).toEqual(['C']);
  });

  it('⌘/Ctrl + Enter 触发保存，新建题目显示「保存并继续添加」', async () => {
    const { wrapper } = mountForm(draft());
    await wrapper.find('#objective-question-editor').trigger('keydown', { key: 'Enter', ctrlKey: true });
    expect(wrapper.emitted('save')?.[0]).toEqual([false]);

    const next = wrapper.findAll('button').find((b) => b.text() === '保存并继续添加');
    await next!.trigger('click');
    expect(wrapper.emitted('save')?.[1]).toEqual([true]);
  });

  it('编辑已有小题时不显示「保存并继续添加」', () => {
    const { wrapper } = mountForm(draft({ id: 'q-1' }));
    expect(wrapper.findAll('button').some((b) => b.text() === '保存并继续添加')).toBe(false);
  });
});
