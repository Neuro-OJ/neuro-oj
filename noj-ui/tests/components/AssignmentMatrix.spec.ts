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
    expect(view.text()).toContain('100 · 已达标');
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
    expect(view.findAll('button').map((b) => b.text()).join(' ')).not.toContain('100');
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
