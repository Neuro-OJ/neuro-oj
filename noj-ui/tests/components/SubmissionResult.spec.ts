import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import SubmissionResult from '~/components/ui/SubmissionResult.vue';

describe('SubmissionResult', () => {
  it('渲染已评测状态', () => {
    const wrapper = mount(SubmissionResult, {
      props: { status: 'finished', result: { status: 'finished' } },
    });
    expect(wrapper.text()).toContain('已评测');
  });

  it('渲染出错状态', () => {
    const wrapper = mount(SubmissionResult, {
      props: { status: 'error', result: { status: 'error' } },
    });
    expect(wrapper.text()).toContain('出错');
  });

  it('排队中显示等待评测', () => {
    const wrapper = mount(SubmissionResult, {
      props: { status: 'pending', result: null, queue_position: 2 },
    });
    expect(wrapper.text()).toContain('等待评测');
  });
});
