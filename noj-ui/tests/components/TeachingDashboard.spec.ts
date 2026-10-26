import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { computed, ref, watch } from 'vue';
import TeachingDashboard from '~/components/education/TeachingDashboard.vue';
import type { EducationDashboardData } from '~/utils/education-dashboard';
const data = {
  assignments: [{
    id: 'task',
    title: '训练任务',
    classroom_id: 'room',
    classroom_name: '一班',
    state: 'published',
    published_at: '2026-10-12',
    deadline_at: null,
    ended_at: null,
    summary: {
      total_students: null,
      total_items: 5,
      achieved_cells: null,
      below_target_students: null,
      unavailable_items: 0,
      updating: false,
    },
  }],
  help_requests: [],
  total: 1,
  page: 1,
  per_page: 20,
} as EducationDashboardData;
const stubs = {
  UCard: { template: '<div><slot /></div>' },
  USelect: { template: '<select />' },
  UBadge: { template: '<span><slot /></span>' },
  UButton: { template: '<button><slot /></button>' },
  NuxtLink: { template: '<a><slot /></a>' },
  UAlert: { props: ['title'], template: '<p>{{ title }}</p>' },
};
beforeEach(() => {
  for (const [name, value] of Object.entries({ computed, ref, watch })) vi.stubGlobal(name, value);
});
describe('教学聚合工作台', () => {
  it('只拥有作业管理权限时不把未授权学生统计显示为零', () => {
    const view = mount(TeachingDashboard, { props: { slug: 'school', mode: 'teaching', data }, global: { stubs } });
    expect(view.text()).toContain('训练任务');
    expect(view.text()).not.toContain('0 名尚未达标');
    expect(view.text()).not.toContain('目标学生');
  });
  it('个人进度更新时隐藏旧达标数，并明确提示资源不可用', () => {
    const changed = structuredClone(data);
    changed.assignments[0]!.summary = {
      ...changed.assignments[0]!.summary,
      achieved_cells: 5,
      updating: true,
      unavailable_items: 2,
    };
    const view = mount(TeachingDashboard, {
      props: { slug: 'school', mode: 'my-learning', data: changed },
      global: { stubs },
    });
    expect(view.text()).toContain('成绩正在更新');
    expect(view.text()).not.toContain('已达标 5');
    expect(view.text()).toContain('2 道题资源不可用');
  });
});
