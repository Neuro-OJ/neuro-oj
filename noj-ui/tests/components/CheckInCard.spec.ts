import { describe, expect, it } from 'vitest';
import { shallowMount } from '@vue/test-utils';
import CheckInCard from '~/components/feature/CheckInCard.vue';

const baseProps = {
  isLoggedIn: true,
  username: 'tester',
  checkedIn: false,
  fadeWhite: false,
  showText: false,
  streakCount: 3,
  showStreak: true,
  checkInLoaded: true,
};

describe('CheckInCard', () => {
  it('渲染连续签到天数', () => {
    const wrapper = shallowMount(CheckInCard, { props: baseProps });
    expect(wrapper.text()).toContain('3');
  });

  it('点击签到按钮触发 checkin 事件', async () => {
    const wrapper = shallowMount(CheckInCard, { props: baseProps });
    await wrapper.find('button').trigger('click');
    expect(wrapper.emitted('checkin')).toHaveLength(1);
  });

  it('未登录显示登录提示', () => {
    const wrapper = shallowMount(CheckInCard, {
      props: { ...baseProps, isLoggedIn: false },
    });
    expect(wrapper.text()).toContain('登录以解锁');
  });
});
