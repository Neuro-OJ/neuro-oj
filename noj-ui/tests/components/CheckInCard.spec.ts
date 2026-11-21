import { describe, expect, it } from 'vitest';
import { shallowMount } from '@vue/test-utils';
import CheckInCard from '~/components/ranking/CheckinCard.vue';

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

// 签到按钮已换成 UButton；shallowMount 默认把它换成无行为的 stub，这里还原成原生 button。
const global = { stubs: { UButton: { template: '<button><slot /></button>' } } };

describe('CheckInCard', () => {
    it('渲染连续签到天数', () => {
        const wrapper = shallowMount(CheckInCard, { props: baseProps, global });
        expect(wrapper.text()).toContain('3');
    });

    it('点击签到按钮触发 checkin 事件', async () => {
        const wrapper = shallowMount(CheckInCard, { props: baseProps, global });
        await wrapper.find('button').trigger('click');
        expect(wrapper.emitted('checkin')).toHaveLength(1);
    });

    it('未登录显示登录提示', () => {
        const wrapper = shallowMount(CheckInCard, {
            props: { ...baseProps, isLoggedIn: false },
            global,
        });
        expect(wrapper.text()).toContain('登录以解锁');
    });
});
