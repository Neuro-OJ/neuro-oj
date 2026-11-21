import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { onUnmounted, ref } from 'vue';
import ProblemStatement from '~/components/problem/ProblemStatement.vue';

beforeEach(() => {
  vi.clearAllMocks();
  for (const [name, value] of Object.entries({ ref, onUnmounted })) vi.stubGlobal(name, value);
  vi.stubGlobal('useCopyText', () => ({ copyText: vi.fn() }));
});

describe('ProblemStatement 折叠与展开', () => {
  it('点击收起后工具条原位切换为展开按钮并可重新展开', async () => {
    const wrapper = mount(ProblemStatement, {
      props: {
        content: '给定两个整数 a 和 b，求 a + b。',
        expanded: true,
        'onUpdate:expanded': (value: boolean) => wrapper.setProps({ expanded: value }),
      },
      global: {
        stubs: {
          UIcon: { props: ['name'], template: '<i :data-icon="name" />' },
          NuxtLink: { template: '<a><slot /></a>' },
          MarkdownRenderer: { props: ['content'], template: '<div class="md">{{ content }}</div>' },
        },
      },
    });

    expect(wrapper.find('.md').exists()).toBe(true);
    const toggleBtn = () =>
      wrapper.findAll('button').find((b) => b.text().includes('收起') || b.text().includes('展开'))!;

    expect(toggleBtn().text()).toContain('收起');
    expect(toggleBtn().attributes('aria-expanded')).toBe('true');

    await toggleBtn().trigger('click');
    expect(wrapper.find('.md').exists()).toBe(false);
    expect(toggleBtn().text()).toContain('展开');
    expect(toggleBtn().attributes('aria-expanded')).toBe('false');

    await toggleBtn().trigger('click');
    expect(wrapper.find('.md').exists()).toBe(true);
    expect(toggleBtn().text()).toContain('收起');
    expect(toggleBtn().attributes('aria-expanded')).toBe('true');
    wrapper.unmount();
  });
});
