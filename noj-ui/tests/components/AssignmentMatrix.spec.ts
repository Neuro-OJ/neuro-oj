import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import AssignmentMatrix from '~/components/education/AssignmentMatrix.vue';
import type { MatrixData, TeachingCell } from '~/utils/education';

const cell: TeachingCell = {
  item_id: 'item',
  user_id: 'student',
  status: 'achieved',
  score: 10000,
  accepted: true,
  updating: false,
  late: false,
  source_submission_id: 'original',
  source_kind: 'submission',
  evaluated_version_id: 'version',
  policy_revision: 2,
};
const matrix: MatrixData = {
  page: 1,
  per_page: 50,
  total: 1,
  scope: 'on_time',
  updating: false,
  items: [{
    id: 'item',
    reference: { display_ref: 'main:1001', qualified_ref: 'main:1001' },
    problem_id: 'problem',
    binding_id: 'binding',
    requirement: 'min_score',
    minimum_score: 6000,
    resource_available: true,
    answer_version_id: 'version',
    policy_revision: 2,
  }],
  rows: [{ user_id: 'student', username: '学生甲', recipient_status: 'active', cells: [cell] }],
};
const stubs = {
  UCard: { template: '<div><slot /></div>' },
  UAlert: { props: ['title'], template: '<p>{{ title }}</p>' },
  UButton: { template: '<button><slot /></button>' },
};
describe('成绩矩阵', () => {
  it('显示来源题号、达标要求和成绩，单元详情携带稳定学生与原提交', async () => {
    const view = mount(AssignmentMatrix, { props: { matrix }, global: { stubs } });
    expect(view.text()).toContain('main:1001');
    expect(view.text()).toContain('至少 60 分');
    expect(view.get('button').attributes('aria-label')).toContain('100 分 · 已达标');
    expect(view.text()).toContain('1/1 达标');
    await view.get('button').trigger('click');
    expect(view.emitted('select')?.[0]).toEqual(['student', cell]);
  });
  it('投影更新期间不展示旧高分或已达标，窄屏同样使用受控状态', () => {
    const updating = {
      ...matrix,
      updating: true,
      rows: [{ ...matrix.rows[0]!, cells: [{ ...cell, updating: true }] }],
    };
    const view = mount(AssignmentMatrix, { props: { matrix: updating }, global: { stubs } });
    expect(view.text()).toContain('成绩正在更新');
    expect(view.text()).toContain('更新中');
    expect(view.findAll('button').map((b) => b.text()).join(' ')).not.toMatch(/\b100\b/);
    expect(view.text()).not.toContain('已达标');
  });
  it('历史学生和空筛选结果保持明确，不构造不存在的单元', () => {
    const view = mount(AssignmentMatrix, {
      props: { matrix: { ...matrix, rows: [{ ...matrix.rows[0]!, recipient_status: 'historical' }] } },
      global: { stubs },
    });
    expect(view.text()).toContain('历史学生');
    const empty = mount(AssignmentMatrix, { props: { matrix: { ...matrix, rows: [], total: 0 } }, global: { stubs } });
    expect(empty.text()).toContain('没有符合筛选条件');
    expect(empty.findAll('button')).toHaveLength(0);
  });
});

describe('手机成绩摘要', () => {
  it('同一矩阵刷新成绩保留展开和键盘焦点，结构变化才重置', async () => {
    const rows = [
      matrix.rows[0]!,
      { ...matrix.rows[0]!, user_id: 'second', username: '学生乙', cells: [{ ...cell, user_id: 'second' }] },
    ];
    const view = mount(AssignmentMatrix, { props: { matrix: { ...matrix, rows } }, global: { stubs } });
    const toggle = view.get('ul[aria-label="学生成绩摘要"] button[aria-expanded]');
    await toggle.trigger('click');
    await view.get('button[data-row="1"]').trigger('focus');
    const refreshed = {
      ...matrix,
      rows: rows.map((row) => ({ ...row, cells: row.cells.map((value) => ({ ...value, score: 9000 })) })),
    };
    await view.setProps({ matrix: refreshed });
    expect(toggle.attributes('aria-expanded')).toBe('true');
    expect(view.get('#student-results-student').isVisible()).toBe(true);
    expect(view.get('button[data-row="1"]').attributes('tabindex')).toBe('0');
    await view.get('#student-results-student button').trigger('click');
    expect(view.emitted('select')?.[0]).toEqual(['student', refreshed.rows[0]!.cells[0]]);
    for (
      const changed of [
        { ...refreshed, page: 2 },
        { ...refreshed, scope: 'current' as const },
        { ...refreshed, rows: refreshed.rows.slice(0, 1) },
        { ...refreshed, items: [...matrix.items, { ...matrix.items[0]!, id: 'replacement' }] },
      ]
    ) {
      await view.setProps({ matrix: refreshed });
      if (toggle.attributes('aria-expanded') !== 'true') await toggle.trigger('click');
      await view.setProps({ matrix: changed });
      expect(toggle.attributes('aria-expanded')).toBe('false');
      expect(view.get('button[data-row="0"]').attributes('tabindex')).toBe('0');
    }
  });
  it('40人默认折叠，每次只展开一人，翻页关闭旧展开且保持原提交入口', async () => {
    const rows = Array.from(
      { length: 40 },
      (_, i) => ({
        ...matrix.rows[0]!,
        user_id: `u${i}`,
        username: `长名字学生${i}`,
        cells: [{ ...cell, user_id: `u${i}` }],
      }),
    );
    const view = mount(AssignmentMatrix, { props: { matrix: { ...matrix, rows } }, global: { stubs } });
    const summaries = view.get('ul[aria-label="学生成绩摘要"]');
    const toggles = summaries.findAll('button[aria-expanded]');
    expect(toggles).toHaveLength(40);
    expect(toggles.every((button) => button.attributes('aria-expanded') === 'false')).toBe(true);
    await toggles[0]!.trigger('click');
    expect(toggles[0]!.attributes('aria-expanded')).toBe('true');
    await toggles[1]!.trigger('click');
    expect(toggles[0]!.attributes('aria-expanded')).toBe('false');
    expect(toggles[1]!.attributes('aria-expanded')).toBe('true');
    await summaries.findAll('li')[1]!.find('div button').trigger('click');
    expect(view.emitted('select')?.[0]?.[0]).toBe('u1');
    await view.setProps({ matrix: { ...matrix, page: 2, rows } });
    expect(toggles[1]!.attributes('aria-expanded')).toBe('false');
  });
});
