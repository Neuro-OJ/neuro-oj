import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, nextTick } from 'vue';
import MarkdownEditor from '~/components/shared/MarkdownEditor.vue';

// 预览渲染器依赖 KaTeX / DOMPurify，组件测试只关心传入的内容
const MarkdownRendererStub = defineComponent({
  name: 'MarkdownRenderer',
  props: { content: { type: String, default: '' } },
  setup: (props) => () => h('div', { class: 'md-stub' }, props.content),
});

const global = { stubs: { UIcon: true, MarkdownRenderer: MarkdownRendererStub } };

function mountEditor(modelValue: string, extra: Record<string, unknown> = {}) {
  const wrapper = mount(MarkdownEditor, {
    props: {
      modelValue,
      'onUpdate:modelValue': (v: string) => wrapper.setProps({ modelValue: v }),
      ...extra,
    },
    global,
    attachTo: document.body,
  });
  return wrapper;
}

describe('MarkdownEditor', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('默认分屏：同时渲染编辑区与预览区', () => {
    const wrapper = mountEditor('# 标题');
    expect(wrapper.find('textarea').isVisible()).toBe(true);
    expect(wrapper.find('.md-stub').text()).toBe('# 标题');
  });

  it('输入后防抖刷新预览', async () => {
    const wrapper = mountEditor('');
    await wrapper.find('textarea').setValue('**新内容**');
    expect(wrapper.find('.md-stub').exists()).toBe(false);
    vi.advanceTimersByTime(250);
    await nextTick();
    expect(wrapper.find('.md-stub').text()).toBe('**新内容**');
  });

  it('切换到编辑模式隐藏预览，预览模式隐藏编辑区', async () => {
    const wrapper = mountEditor('正文');
    const tabs = wrapper.findAll('[role="tab"]');
    await tabs[0]!.trigger('click');
    expect(wrapper.find('.md-stub').exists()).toBe(false);
    await tabs[2]!.trigger('click');
    expect(wrapper.find('textarea').isVisible()).toBe(false);
    expect(wrapper.find('.md-stub').exists()).toBe(true);
  });

  it('Ctrl+B 加粗选中文本', async () => {
    const wrapper = mountEditor('hello world');
    const el = wrapper.find('textarea').element as HTMLTextAreaElement;
    el.setSelectionRange(6, 11);
    await wrapper.find('textarea').trigger('keydown', { key: 'b', ctrlKey: true });
    expect(wrapper.props('modelValue')).toBe('hello **world**');
  });

  it('工具栏按钮插入内容，超出 maxlength 时不修改', async () => {
    const wrapper = mountEditor('abc', { maxlength: 4 });
    const el = wrapper.find('textarea').element as HTMLTextAreaElement;
    el.setSelectionRange(0, 3);
    await wrapper.find('button[aria-label="加粗（Ctrl+B）"]').trigger('click');
    expect(wrapper.props('modelValue')).toBe('abc');
  });

  it('显示字符计数', () => {
    const wrapper = mountEditor('12345', { maxlength: 100 });
    expect(wrapper.text()).toContain('5 / 100 字符');
  });
});
