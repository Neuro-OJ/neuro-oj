import { describe, expect, it } from 'vitest';
import { shallowMount } from '@vue/test-utils';
import ProblemContestNotice from '~/components/problem/ProblemContestNotice.vue';

/** NuxtLink 在组件测试环境中不存在，用等价 a 标签桩断言跳转地址。 */
const stubs = {
  NuxtLink: {
    props: ['to'],
    template: '<a :href="String(to)"><slot /></a>',
  },
};

describe('ProblemContestNotice', () => {
  it('渲染保密文案与竞赛名称，并链接到竞赛首页', () => {
    const wrapper = shallowMount(ProblemContestNotice, {
      props: { contests: [{ public_id: 'ct-1', title: '春季公开赛' }] },
      global: { stubs },
    });

    expect(wrapper.text()).toContain('当前题目已经被关联到竞赛');
    expect(wrapper.text()).toContain('春季公开赛');
    expect(wrapper.text()).toContain('仅管理员和题目所有者可见，请注意保密工作');
    expect(wrapper.find('a').attributes('href')).toBe('/contests/ct-1');
    // 不可关闭：不应出现任何关闭按钮
    expect(wrapper.find('button').exists()).toBe(false);
  });

  it('一题关联多场竞赛时全部列出', () => {
    const wrapper = shallowMount(ProblemContestNotice, {
      props: {
        contests: [
          { public_id: 'ct-1', title: '春季公开赛' },
          { public_id: 'ct-2', title: '夏季公开赛' },
        ],
      },
      global: { stubs },
    });

    const links = wrapper.findAll('a');
    expect(links).toHaveLength(2);
    expect(links[1].attributes('href')).toBe('/contests/ct-2');
  });

  it('无关联竞赛时不渲染任何内容', () => {
    const wrapper = shallowMount(ProblemContestNotice, {
      props: { contests: [] },
      global: { stubs },
    });

    expect(wrapper.find('[role="status"]').exists()).toBe(false);
    expect(wrapper.text()).toBe('');
  });
});
