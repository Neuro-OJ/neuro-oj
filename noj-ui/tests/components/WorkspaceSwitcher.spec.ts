import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import WorkspaceSwitcher from '~/components/workspace/WorkspaceSwitcher.vue';

const school = { id: 's1', slug: 'school-one', name: '学校一', description: '', status: 'active' as const };
const team = { ...school, id: 's2', slug: 'team-two', name: '团队二' };
const stubs = {
  NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
  UButton: { template: '<button><slot /></button>' },
  UDropdownMenu: {
    props: ['items'],
    template:
      '<div data-testid="switch-menu"><slot /><button @click="items[0][1].onSelect()">选第二个空间</button></div>',
  },
};
describe('工作空间切换入口', () => {
  it('只有一个可用空间时隐藏切换器，仍显示当前空间入口', () => {
    const wrapper = mount(WorkspaceSwitcher, {
      props: { workspaces: [school], currentSlug: school.slug },
      global: { stubs },
    });
    expect(wrapper.find('[data-testid="switch-menu"]').exists()).toBe(false);
    expect(wrapper.get('a').attributes('href')).toBe('/d/school-one');
  });
  it('两个空间的点击仅发出明确目标，保留来源选择', async () => {
    const wrapper = mount(WorkspaceSwitcher, {
      props: { workspaces: [school, team], currentSlug: school.slug },
      global: { stubs },
    });
    expect(wrapper.text()).toContain('学校一');
    await wrapper.get('button:last-child').trigger('click');
    expect(wrapper.emitted('select')?.[0]).toEqual([team]);
  });
  it('请求尚未完成时不展示旧的切换选项', () => {
    const wrapper = mount(WorkspaceSwitcher, {
      props: { workspaces: [school, team], currentSlug: school.slug, pending: true },
      global: { stubs },
    });
    expect(wrapper.find('[data-testid="switch-menu"]').exists()).toBe(false);
  });
});
