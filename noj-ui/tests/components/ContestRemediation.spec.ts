import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, ref, Suspense, watch } from 'vue';
import ContestRemediation from '~/components/education/ContestRemediationBuilder.vue';
import RemediationSelection from '~/components/education/RemediationSelection.vue';
import type { ContestRemediationPreview } from '~/utils/education-remediation-preview';
const education = { contestRemediationPreview: vi.fn(), createContestRemediation: vi.fn() };
const contests = { list: vi.fn() }, navigate = vi.fn();
const facts = (): ContestRemediationPreview => ({
  source: {
    kind: 'contest',
    id: 'contest1',
    title: '班级赛',
    revision: 5,
    ranking_source: 'official',
    snapshot_version: 2,
  },
  preview_token: 'official-v2-facts',
  updating: false,
  students: [{ user_id: 'student', username: '待补题学生', item_ids: ['problem-id'] }],
  items: [{
    id: 'problem-id',
    label: 'A',
    binding_id: 'binding-id',
    reference: { display_ref: 'main:1001', qualified_ref: 'main:1001' },
    requirement: 'accepted',
    minimum_score: null,
    resource_available: true,
    policy_revision: 3,
  }],
  excluded: { pending_cells: 0, unavailable_items: 0, historical_students: 1, nonparticipants: 2 },
});
const stubs = {
  UButton: { props: ['disabled'], template: '<button :disabled="disabled"><slot /></button>' },
  AsyncContent: { template: '<div><slot /></div>' },
  UCard: { template: '<div><slot /></div>' },
  AdminFormField: { props: ['label'], template: '<label>{{ label }}<slot /></label>' },
  UInput: {
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template: '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
  USelect: {
    props: ['modelValue', 'items'],
    emits: ['update:modelValue'],
    template:
      '<select :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value)"><option v-for="item in items" :value="item.value">{{ item.label }}</option></select>',
  },
  URadioGroup: {
    props: ['modelValue', 'items'],
    emits: ['update:modelValue'],
    template:
      '<select :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value)"><option value="">请选择</option><option v-for="item in items" :value="item.value">{{ item.label }}</option></select>',
  },
  UCheckbox: {
    props: ['label', 'modelValue'],
    emits: ['update:modelValue'],
    template:
      '<label><input type="checkbox" :checked="modelValue" @change="$emit(\'update:modelValue\', $event.target.checked)" />{{ label }}</label>',
  },
  UAlert: { props: ['title', 'description'], template: '<p>{{ title }} {{ description }}</p>' },
  UPagination: true,
};
beforeEach(() => {
  vi.clearAllMocks();
  for (const [name, value] of Object.entries({ computed, ref, watch })) vi.stubGlobal(name, value);
  vi.stubGlobal('useEducationApi', () => education);
  vi.stubGlobal('useDomainContests', () => contests);
  vi.stubGlobal('useWorkspaceActionScope', () => () => ({ slug: 'school', isCurrent: () => true }));
  vi.stubGlobal('useState', () => ref({ id: 'coach' }));
  vi.stubGlobal('navigateTo', navigate);
  vi.stubGlobal('useAsyncData', async (_key: unknown, loader: () => Promise<unknown>) => ({
    data: ref(await loader()),
    error: ref(null),
    status: ref('success'),
    refresh: vi.fn(),
  }));
  contests.list.mockResolvedValue({
    data: [{ id: 'contest1', title: '班级赛' }],
    pagination: { total: 1, total_pages: 1 },
  });
  education.contestRemediationPreview.mockResolvedValue({ data: facts() });
  education.createContestRemediation.mockResolvedValue({ data: { id: 'independent-draft' } });
});
async function view() {
  const Wrapper = defineComponent({
    setup: () => () =>
      h(Suspense, null, {
        default: () => h(ContestRemediation, { slug: 'school', classroomId: 'class-one', writable: true }),
      }),
  });
  const result = mount(Wrapper, { global: { components: { RemediationSelection }, stubs } });
  await flushPromises();
  await result.get('select[aria-label="补题来源比赛"]').setValue('contest1');
  return result;
}
describe('授权比赛来源补题', () => {
  it('默认正式快照，展示版本及未参赛排除数，创建新草稿保留原分/通过口径', async () => {
    const result = await view();
    await result.findAll('button').find((button) => button.text() === '预览全班候选')!.trigger('click');
    await flushPromises();
    expect(contests.list).toHaveBeenCalledWith('school', 1);
    expect(education.contestRemediationPreview).toHaveBeenCalledWith('school', 'class-one', {
      contest_id: 'contest1',
      ranking_source: 'official',
      requirement: 'accepted',
    });
    expect(result.text()).toContain('正式快照 v2');
    expect(result.text()).toContain('2 名班级学生没有参加来源比赛');
    await result.get('form').trigger('submit');
    await flushPromises();
    expect(education.createContestRemediation).toHaveBeenCalledWith('school', 'class-one', 5, expect.any(String), {
      contest_id: 'contest1',
      ranking_source: 'official',
      requirement: 'accepted',
      title: '班级赛（补题）',
      target_student_ids: ['student'],
      item_ids: ['problem-id'],
      deadline_at: null,
      preview_token: 'official-v2-facts',
    });
    expect(navigate).toHaveBeenCalledWith('/d/school/assignments/independent-draft');
  });
  it('切换榜单或要求移除旧候选，最低原分精确转为×100而不读全榜', async () => {
    const result = await view();
    await result.findAll('button').find((button) => button.text() === '预览全班候选')!.trigger('click');
    await flushPromises();
    await result.get('select[aria-label="比赛补题成绩来源"]').setValue('live');
    expect(result.find('form').exists()).toBe(false);
    await result.get('select[aria-label="比赛补题达标要求"]').setValue('min_score');
    await result.get('input[aria-label="比赛补题最低分"]').setValue('60.25');
    await result.findAll('button').find((button) => button.text() === '预览全班候选')!.trigger('click');
    await flushPromises();
    expect(education.contestRemediationPreview).toHaveBeenLastCalledWith('school', 'class-one', {
      contest_id: 'contest1',
      ranking_source: 'live',
      requirement: 'min_score',
      minimum_score: 6025,
    });
  });
  it('受保密限制的比赛返回授权错误，无候选和创建入口', async () => {
    education.contestRemediationPreview.mockRejectedValue({
      data: { error: '当前无权读取比赛成绩', code: 'RESULTS_HIDDEN' },
    });
    const result = await view();
    await result.findAll('button').find((button) => button.text() === '预览全班候选')!.trigger('click');
    await flushPromises();
    expect(result.text()).toContain('当前无权读取比赛成绩');
    expect(result.find('form').exists()).toBe(false);
    expect(education.createContestRemediation).not.toHaveBeenCalled();
  });
});
