import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import SubmissionOutputPanel from '~/components/submission/SubmissionOutputPanel.vue';

/** NuxtLink / UIcon 在组件测试环境中不存在，替换为最小桩件。 */
const stubs = {
  UIcon: true,
  NuxtLink: {
    props: ['to'],
    template: '<a :href="to"><slot /></a>',
  },
};

function mountPanel(props: { status: string; output: string | null; isLoggedIn: boolean }) {
  // isVisible() 依赖计算样式，需挂载到 document 上才能识别 v-show 的 display: none
  return mount(SubmissionOutputPanel, { props, global: { stubs }, attachTo: document.body });
}

function outputBlock(wrapper: ReturnType<typeof mountPanel>) {
  return wrapper.find('[data-testid="submission-output"]');
}

describe('SubmissionOutputPanel', () => {
  it('出错提交默认展开并显示错误信息', () => {
    const wrapper = mountPanel({
      status: 'error',
      output: '评测环境配置错误：题目需要评测容器联网 (submission: sid)',
      isLoggedIn: true,
    });
    expect(wrapper.text()).toContain('错误信息');
    const block = outputBlock(wrapper);
    expect(block.exists()).toBe(true);
    expect(block.isVisible()).toBe(true);
    expect(block.text()).toContain('评测环境配置错误');
  });

  it('已完成提交默认折叠，点击后展开', async () => {
    const wrapper = mountPanel({ status: 'finished', output: 'score=100', isLoggedIn: true });
    expect(wrapper.text()).toContain('评测输出');
    expect(outputBlock(wrapper).isVisible()).toBe(false);
    await wrapper.find('button').trigger('click');
    expect(outputBlock(wrapper).isVisible()).toBe(true);
  });

  it('状态从 finished 变为 error 时自动展开', async () => {
    const wrapper = mountPanel({ status: 'finished', output: 'x', isLoggedIn: true });
    await wrapper.setProps({ status: 'error' });
    expect(outputBlock(wrapper).isVisible()).toBe(true);
  });

  it('未登录且无输出时提示登录', () => {
    const wrapper = mountPanel({ status: 'error', output: null, isLoggedIn: false });
    expect(outputBlock(wrapper).exists()).toBe(false);
    expect(wrapper.text()).toContain('登录后查看评测输出');
    expect(wrapper.find('a[href="/login"]').exists()).toBe(true);
  });

  it('已登录但无权查看时不再误导为登录', () => {
    const wrapper = mountPanel({ status: 'finished', output: null, isLoggedIn: true });
    expect(wrapper.text()).toContain('仅提交者与管理员可查看评测输出');
    expect(wrapper.find('a[href="/login"]').exists()).toBe(false);
  });

  it('复制按钮发出 copy 事件', async () => {
    const wrapper = mountPanel({ status: 'error', output: 'err', isLoggedIn: true });
    await wrapper.find('[title="复制评测输出"]').trigger('click');
    expect(wrapper.emitted('copy')).toEqual([['err']]);
  });
});
