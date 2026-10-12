import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ContestHiddenMark from '~/components/problem/ContestHiddenMark.vue';
import { CONTEST_HIDDEN_TIP } from '~/utils/contestHidden';

/**
 * UTooltip / UIcon 在组件测试环境不存在，用渲染插槽的桩替代：
 * 关键是断言"提示文案来自单一事实来源"，而不是 Nuxt UI 的浮层行为。
 */
const stubs = {
  UTooltip: {
    props: ['text'],
    template: '<span data-testid="tooltip" :data-tip="text"><slot /></span>',
  },
  UIcon: true,
};

describe('ContestHiddenMark', () => {
  it('渲染「已收编」标识，并把统一提示文案传给 Tooltip', () => {
    const wrapper = mount(ContestHiddenMark, { global: { stubs } });

    expect(wrapper.text()).toContain('已收编');
    expect(wrapper.get('[data-testid="tooltip"]').attributes('data-tip')).toBe(CONTEST_HIDDEN_TIP);
    expect(wrapper.get('[data-testid="tooltip"]').attributes('data-tip')).toBe(
      '该题目已被公开赛收编，当前对普通用户处于隐藏保密状态',
    );
  });
});
