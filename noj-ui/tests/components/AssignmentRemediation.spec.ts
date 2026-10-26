import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, ref, watch } from 'vue';
import AssignmentRemediation from '~/components/education/AssignmentRemediation.vue';
import RemediationSelection from '~/components/education/RemediationSelection.vue';
import type { AssignmentDetail } from '~/utils/education';
import type { AssignmentRemediationPreview } from '~/utils/education-remediation-preview';
const api = { remediationPreview: vi.fn(), createRemediation: vi.fn() };
const navigate = vi.fn();
const preview = (): AssignmentRemediationPreview => ({
  source: { kind: 'assignment', id: 'task-one', title: '原作业', revision: 7, scope: 'current' },
  preview_token: 'whole-class-facts',
  updating: false,
  students: [
    { user_id: 'student-first', username: '第一名学生', item_ids: ['item1'] },
    { user_id: 'student-last', username: '末页学生', item_ids: ['item2'] },
  ],
  items: [1, 2].map((n) => ({
    id: `item${n}`,
    reference: { display_ref: `main:100${n}`, qualified_ref: `main:100${n}` },
    problem_id: `p${n}`,
    binding_id: `b${n}`,
    requirement: 'min_score',
    minimum_score: 6000,
    resource_available: true,
    answer_version_id: 'v1',
    policy_revision: 1,
  })),
  excluded: { pending_cells: 1, unavailable_items: 1, historical_students: 2 },
});
const stubs = {
  UButton: { props: ['disabled'], template: '<button :disabled="disabled"><slot /></button>' },
  UModal: { props: ['open'], template: '<div v-if="open"><slot name="body" /></div>' },
  AdminFormField: { props: ['label'], template: '<label>{{ label }}<slot /></label>' },
  UInput: {
    props: ['modelValue', 'disabled'],
    emits: ['update:modelValue'],
    template:
      '<input :value="modelValue" :disabled="disabled" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
  USelect: { props: ['modelValue'], template: '<span>{{ modelValue }}</span>' },
  UCheckbox: {
    props: ['label', 'modelValue', 'disabled'],
    emits: ['update:modelValue'],
    template:
      '<label><input type="checkbox" :checked="modelValue" :disabled="disabled" @change="$emit(\'update:modelValue\', $event.target.checked)" />{{ label }}</label>',
  },
  UAlert: { props: ['title', 'description'], template: '<p>{{ title }} {{ description }}</p>' },
};
beforeEach(() => {
  vi.clearAllMocks();
  for (const [name, value] of Object.entries({ computed, ref, watch })) vi.stubGlobal(name, value);
  vi.stubGlobal('useEducationApi', () => api);
  vi.stubGlobal('useWorkspaceActionScope', () => () => ({ slug: 'school', isCurrent: () => true }));
  vi.stubGlobal('navigateTo', navigate);
  api.remediationPreview.mockResolvedValue({ data: preview() });
  api.createRemediation.mockResolvedValue({ data: { id: 'new-draft' } });
});
function view(canReadProgress = true) {
  return mount(AssignmentRemediation, {
    props: {
      slug: 'school',
      task: { id: 'task-one', title: '原作业', published_at: '2026-10-13' } as AssignmentDetail,
      writable: true,
      canReadProgress,
    },
    global: { components: { RemediationSelection }, stubs },
  });
}
describe('全班未达标补题预览', () => {
  it('同一作业的后台刷新保留打开的预览和输入，真正换任务才重置', async () => {
    const result = view();
    await result.get('button').trigger('click');
    await flushPromises();
    await result.get('input[aria-label="补题任务标题"]').setValue('保留中的补题草稿');
    const original = result.get('form').element;
    await result.setProps({ task: { ...result.props('task'), revision: 8 } });
    expect(result.get('form').element).toBe(original);
    expect((result.get('input[aria-label="补题任务标题"]').element as HTMLInputElement).value).toBe('保留中的补题草稿');
    await result.setProps({ task: { ...result.props('task'), id: 'task-two' } });
    expect(result.find('form').exists()).toBe(false);
    result.unmount();
  });
  it('读取全班接口，末页学生也可选择，创建保留事实token和来源revision', async () => {
    const result = view();
    await result.get('button').trigger('click');
    await flushPromises();
    expect(api.remediationPreview).toHaveBeenCalledWith('school', 'task-one', 'current');
    expect(result.text()).toContain('末页学生');
    expect(result.text()).toContain('每名所选学生将收到全部所选题目');
    await result.get('form').trigger('submit');
    await flushPromises();
    expect(api.createRemediation).toHaveBeenCalledWith('school', 'task-one', 7, expect.any(String), {
      title: '原作业（补题）',
      target_student_ids: ['student-first', 'student-last'],
      item_ids: ['item1', 'item2'],
      deadline_at: null,
      scope: 'current',
      preview_token: 'whole-class-facts',
    });
    expect(navigate).toHaveBeenCalledWith('/d/school/assignments/new-draft');
  });
  it('有作业管理但无学情权限不展示全班名单入口、不请求成绩', () => {
    expect(view(false).find('button').exists()).toBe(false);
    expect(api.remediationPreview).not.toHaveBeenCalled();
  });
  it('预览可明确缩小学生和题目范围，新任务仍采用统一题目集合', async () => {
    const result = view();
    await result.get('button').trigger('click');
    await flushPromises();
    const checks = result.findAll('input[type="checkbox"]');
    await checks[0]!.setValue(false);
    await checks[2]!.setValue(false);
    await result.get('form').trigger('submit');
    await flushPromises();
    expect(api.createRemediation.mock.calls[0]![4]).toMatchObject({
      target_student_ids: ['student-last'],
      item_ids: ['item2'],
    });
  });
  it('默认只选择有未达标候选的有效题目，不选择不可用或已全员达标题', async () => {
    const facts = preview();
    facts.items.push({ ...facts.items[0]!, id: 'unavailable', resource_available: false });
    facts.items.push({ ...facts.items[0]!, id: 'all-achieved' });
    api.remediationPreview.mockResolvedValue({ data: facts });
    const result = view();
    await result.get('button').trigger('click');
    await flushPromises();
    expect(result.findAll('input[type="checkbox"]')).toHaveLength(4);
    await result.get('form').trigger('submit');
    await flushPromises();
    expect(api.createRemediation.mock.calls[0]![4].item_ids).toEqual(['item1', 'item2']);
  });
  it('部分成绩更新仍可给稳定候选布置补题；候选冲突保留表单、相同重试保持幂等键', async () => {
    api.remediationPreview.mockResolvedValueOnce({ data: { ...preview(), updating: true } });
    const pending = view();
    await pending.get('button').trigger('click');
    await flushPromises();
    await pending.get('form').trigger('submit');
    await flushPromises();
    expect(api.createRemediation).toHaveBeenCalledOnce();
    pending.unmount();
    api.createRemediation.mockClear();
    navigate.mockClear();
    api.createRemediation.mockRejectedValue({
      data: { error: '候选成绩已变化，请刷新预览', code: 'REMEDIATION_PREVIEW_CHANGED' },
    });
    const result = view();
    await result.get('button').trigger('click');
    await flushPromises();
    await result.get('input[aria-label="补题任务标题"]').setValue('我的补题');
    await result.get('form').trigger('submit');
    await flushPromises();
    expect(result.text()).toContain('候选成绩已变化');
    expect(result.get('input[aria-label="补题任务标题"]').element.value).toBe('我的补题');
    await result.get('form').trigger('submit');
    await flushPromises();
    expect(api.createRemediation.mock.calls[0]![3]).toBe(api.createRemediation.mock.calls[1]![3]);
    expect(navigate).not.toHaveBeenCalled();
  });
});
