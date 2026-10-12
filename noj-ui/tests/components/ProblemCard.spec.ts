import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ProblemCard from '~/components/card/ProblemCard.vue';
import { CONTEST_HIDDEN_STRIPES_CLASS } from '~/utils/contestHidden';

/** NuxtLink 在组件测试环境中不存在，用等价 a 标签桩断言 class 与跳转地址。 */
const stubs = {
  NuxtLink: {
    props: ['to'],
    template: '<a :href="String(to)"><slot /></a>',
  },
  MarqueeTitle: true,
  DifficultyBadge: true,
  ContestHiddenMark: true,
};

const baseProps = {
  id: 'p1',
  display_id: 'P1000',
  type: 'P',
  title: 'A+B Problem',
  difficulty: 'easy',
  runtime_config: { evaluator: { time_limit_ms: 1000, memory_limit_mb: 256 } },
  is_objective: false,
  tags: [],
};

describe('ProblemCard 公开赛收编标识（VULN-07）', () => {
  it('is_contest_hidden=true 时卡片带斜纹底并渲染收编标识', () => {
    const wrapper = mount(ProblemCard, {
      props: { ...baseProps, is_contest_hidden: true },
      global: { stubs },
    });

    expect(wrapper.get('a').classes()).toContain(CONTEST_HIDDEN_STRIPES_CLASS);
    expect(wrapper.findComponent({ name: 'ContestHiddenMark' }).exists()).toBe(true);
  });

  it('后端未下发该字段（普通用户 / 旧后端）时不着色、不渲染标识', () => {
    const wrapper = mount(ProblemCard, {
      props: baseProps,
      global: { stubs },
    });

    expect(wrapper.get('a').classes()).not.toContain(CONTEST_HIDDEN_STRIPES_CLASS);
    expect(wrapper.findComponent({ name: 'ContestHiddenMark' }).exists()).toBe(false);
  });
});
