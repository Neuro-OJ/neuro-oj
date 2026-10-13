import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { reactive, ref, watch } from 'vue';
import Comparison from '~/components/education/TrainingComparison.vue';
const compare = vi.fn(), actor = ref('teacher');
const fixture = () => ({
  assignment_id: 'a1',
  user_id: 'student',
  domain_id: 'school-id',
  interval: '[start,end)',
  strategy: 'current_domain_policy',
  computed_at: '2026-10-13T12:00:00Z',
  interpretation: '训练记录比较，不表示能力评价。',
  windows: {
    before_start: '2026-10-11T00:00:00Z',
    before_end: '2026-10-12T00:00:00Z',
    after_start: '2026-10-12T00:00:00Z',
    after_end: '2026-10-13T00:00:00Z',
  },
  before: { accepted_items: 0, achieved_items: 0, scored_items: 0, submitted_count: 1, candidate_count: 0 },
  after: { accepted_items: 0, achieved_items: 1, scored_items: 1, submitted_count: 2, candidate_count: 1 },
  items: [{
    item_id: 'item',
    reference: { display_ref: 'main:1001' },
    requirement: 'min_score',
    minimum_score: 6000,
    resource_available: true,
    policy: { mode: 'exact', revision: 3, required_version_id: 'v2', answer_version_id: 'v2' },
    before: {
      submitted_count: 1,
      candidate_count: 0,
      pending_count: 0,
      version_mismatch_count: 1,
      score: null,
      accepted: false,
      achieved: false,
      best: null,
      passed: null,
    },
    after: {
      submitted_count: 2,
      candidate_count: 1,
      pending_count: 1,
      version_mismatch_count: 0,
      score: 10000,
      accepted: false,
      achieved: true,
      best: {
        received_at: '2026-10-12T12:00:00Z',
        submission_id: 'submission-one',
        source_kind: 'objective',
        score: 10000,
        accepted: false,
        attempt_id: 'attempt-one',
        version_id: 'v2',
      },
      passed: null,
    },
    score_change: null,
  }],
});
beforeEach(() => {
  vi.clearAllMocks();
  actor.value = 'teacher';
  for (const [name, value] of Object.entries({ ref, reactive, watch })) vi.stubGlobal(name, value);
  vi.stubGlobal('useEducationApi', () => ({ trainingComparison: compare }));
  vi.stubGlobal('useWorkspaceActionScope', () => () => {
    const id = actor.value;
    return { slug: 'school', isCurrent: () => actor.value === id };
  });
  compare.mockResolvedValue({ data: fixture() });
});
function view() {
  return mount(Comparison, {
    props: { slug: 'school', assignmentId: 'a1', userId: 'student', anchor: '2026-10-12T00:00:00Z' },
    global: {
      stubs: {
        UButton: { template: '<button><slot /></button>' },
        UCard: { template: '<section><slot /></section>' },
        UAlert: { props: ['title'], template: '<p>{{ title }}</p>' },
        AdminFormField: { template: '<label><slot /></label>' },
        UInput: {
          props: ['modelValue'],
          emits: ['update:modelValue'],
          template: '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
        },
        UCollapsible: { template: '<div><slot /><slot name="content" /></div>' },
      },
    },
  });
}
describe('明确时间窗的训练记录比较', () => {
  it('打开页面不自动扫描，显式比较发送带时区的两个时间窗', async () => {
    const result = view();
    expect(compare).not.toHaveBeenCalled();
    await result.get('button').trigger('click');
    expect(compare).not.toHaveBeenCalled();
    await result.get('form').trigger('submit');
    await flushPromises();
    const [slug, assignment, user, windows] = compare.mock.calls[0]!;
    expect([slug, assignment, user]).toEqual(['school', 'a1', 'student']);
    expect(windows.before_start).toMatch(/Z$/);
    expect(windows.after_start).toBe(windows.before_end);
    expect(result.text()).toContain('包含开始、不包含结束');
  });
  it('缺分不当零分，100分不推断正式通过，展示策略/候选及独立达标', async () => {
    const result = view();
    await result.get('button').trigger('click');
    await result.get('form').trigger('submit');
    await flushPromises();
    expect(result.text()).toContain('暂无正式分数');
    expect(result.text()).toContain('100.00 分');
    expect(result.text()).toContain('无正式通过记录');
    expect(result.text()).toContain('已达到要求');
    expect(result.text()).not.toContain('有正式通过记录');
    expect(result.text()).toContain('版本不匹配 1');
    expect(result.text()).toContain('评测中 1');
    expect(result.text()).toContain('两窗没有可比较的正式分数');
    expect(result.text()).toContain('submission-one');
    expect(result.text()).toContain('attempt-one');
    expect(result.text()).toContain('不表示能力评价');
  });
  it('HTTP错误保留时间窗；身份变化期间完成的比较不写入当前页面', async () => {
    const result = view();
    await result.get('button').trigger('click');
    compare.mockRejectedValue({ statusCode: 400, data: { error: '时间窗不得重叠' } });
    const input = result.get('input[aria-label="训练前开始"]');
    const original = (input.element as HTMLInputElement).value;
    await result.get('form').trigger('submit');
    await flushPromises();
    expect(result.text()).toContain('时间窗不得重叠');
    expect((input.element as HTMLInputElement).value).toBe(original);
    let resolve!: (value: unknown) => void;
    compare.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await result.get('form').trigger('submit');
    actor.value = 'another-teacher';
    resolve({ data: fixture() });
    await flushPromises();
    expect(result.text()).not.toContain('100.00 分');
  });
});
