import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, ref, Suspense, watch } from 'vue';
import AssignmentCellSubmissions from '~/components/education/AssignmentCellSubmissions.vue';
import SubmissionAttemptHistory from '~/components/education/SubmissionAttemptHistory.vue';
const api = { assignmentItemSubmissions: vi.fn(), submissionAttempts: vi.fn() };
const stubs = {
  AsyncContent: { template: '<div><slot /></div>' },
  UAlert: { props: ['title'], template: '<p>{{ title }}</p>' },
  PaginationNav: true,
  SubmissionReview: {
    props: ['submissionId', 'canAnnotate'],
    template: '<p>代码 {{ submissionId }} {{ canAnnotate }}</p>',
  },
  SubmissionAttemptHistory: { props: ['submissionId', 'kind'], template: '<p>沿革 {{ kind }} {{ submissionId }}</p>' },
};
beforeEach(() => {
  vi.clearAllMocks();
  for (const [name, value] of Object.entries({ computed, ref, watch })) vi.stubGlobal(name, value);
  vi.stubGlobal('useAuth', () => ({ user: ref({ id: 'teacher' }) }));
  vi.stubGlobal('useEducationApi', () => api);
  vi.stubGlobal('useAsyncData', async (key: () => string, handler: () => Promise<unknown>) => {
    const data = ref(await handler());
    const refresh = async () => {
      data.value = await handler();
    };
    watch(key, refresh);
    return { data, status: ref('success'), error: ref(null), refresh };
  });
  api.assignmentItemSubmissions.mockResolvedValue({
    data: {
      total: 1,
      policy: { mode: 'any', revision: 4 },
      data: [
        {
          id: 's1',
          kind: 'submission',
          language: 'cpp',
          created_at: '2026-10-13T12:00:00Z',
          score: 2000,
          accepted: false,
          status: 'finished',
          candidate_attempt_ids: ['e2'],
        },
      ],
    },
  });
  api.submissionAttempts.mockResolvedValue({
    data: {
      total: 2,
      resource_available: true,
      data: [
        {
          id: 'e3',
          sequence: 2,
          source: 'rejudge',
          state: 'error',
          result_kind: 'platform_error',
          score: null,
          accepted: false,
          created_at: '2026-10-13T13:00:00Z',
          current_formal: false,
          matches_policy: true,
          oi: null,
        },
        {
          id: 'e2',
          sequence: 1,
          source: 'rejudge',
          state: 'finished',
          result_kind: 'graded',
          score: 2000,
          accepted: false,
          verdict: 'WA',
          created_at: '2026-10-13T12:00:00Z',
          current_formal: true,
          matches_policy: true,
          oi: {
            subtasks: [{
              id: 's1',
              score: 20,
              max_score: 100,
              verdict: 'WA',
              cases: [{ case_id: 'case1', verdict: 'WA', time_ms: 8, memory_kb: 16 }],
            }],
          },
        },
      ],
    },
  });
});
async function render(
  component: typeof AssignmentCellSubmissions | typeof SubmissionAttemptHistory,
  props: Record<string, unknown>,
) {
  const Wrapper = defineComponent({ setup: () => () => h(Suspense, null, { default: () => h(component, props) }) });
  const view = mount(Wrapper, {
    global: { stubs: component === SubmissionAttemptHistory ? { ...stubs, SubmissionAttemptHistory: false } : stubs },
  });
  await flushPromises();
  return view;
}
describe('教学单元提交与正式变化', () => {
  it('按使用域、学生、条目与统计范围取列表，选提交才加载沿革和代码', async () => {
    const view = await render(AssignmentCellSubmissions, {
      slug: 'school',
      assignmentId: 'a1',
      classroomId: 'c1',
      userId: 'student',
      itemId: 'i1',
      scope: 'on_time',
      canAnnotate: false,
    });
    expect(api.assignmentItemSubmissions).toHaveBeenCalledWith('school', 'a1', 'student', 'i1', 'on_time', 1);
    expect(view.text()).not.toContain('沿革 submission');
    await view.find('button').trigger('click');
    await flushPromises();
    expect(view.text()).toContain('沿革 submission s1');
    expect(view.text()).toContain('代码 s1 false');
    expect(view.text()).toContain('存在当前正式候选');
  });
  it('正式沿革显示重测降分、平台失败及允许的OI子任务和测试点元数据', async () => {
    const view = await render(SubmissionAttemptHistory, {
      slug: 'school',
      classroomId: 'c1',
      submissionId: 's1',
      kind: 'submission',
    });
    expect(api.submissionAttempts).toHaveBeenCalledWith('school', 'c1', 'submission', 's1', 1);
    expect(view.text()).toContain('平台评测失败 · 待处理');
    expect(view.text()).toContain('WA · 20 分');
    expect(view.text()).toContain('该版本当前正式判定');
    expect(view.text()).toContain('子任务 s1');
    expect(view.text()).toContain('case1');
    expect(view.text()).toContain('8 ms / 16 KiB');
    expect(view.findAll('article')[0]!.text()).not.toContain('0 分');
  });
});
