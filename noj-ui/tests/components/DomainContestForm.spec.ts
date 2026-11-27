import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, ref, Suspense, watch } from 'vue';
import DomainContestForm from '~/components/contest/ContestForm.vue';
import type { DomainContest } from '~/composables/useDomainContests';

const api = { problems: vi.fn(), update: vi.fn(), create: vi.fn() };
const problemApi = { list: vi.fn() };
const navigateToMock = vi.fn();

function makeContestProblem(
  problemId: string,
  label: string,
  sortOrder: number,
  kind: 'ai' | 'oi' | 'objective' = 'ai',
) {
  return {
    problem_id: problemId,
    sort_order: sortOrder,
    label,
    score: 10000,
    title: `题目 ${label}`,
    description: '',
    difficulty: 'easy',
    display_id: `100${sortOrder + 1}`,
    submission_mode: 'code' as const,
    artifact_max_size_mb: null,
    user_status: 'untouched' as const,
    is_objective: kind === 'objective',
    judge_type: kind === 'oi' ? 'oi' as const : 'dual' as const,
    version_id: `v-${problemId}`,
    version: 1,
    effective_version_policy_revision: 1,
    reference: {
      problem_id: problemId,
      source_domain_id: 'domain-1',
      source_domain_slug: 'school',
      number: 1001 + sortOrder,
      qualified_ref: `school#${1001 + sortOrder}`,
      display_ref: `#${1001 + sortOrder}`,
    },
  };
}

function makeProblemSummary(problemId: string, number: number, kind: 'ai' | 'oi' | 'objective' = 'ai') {
  return {
    reference: {
      problem_id: problemId,
      source_domain_id: 'domain-1',
      source_domain_slug: 'school',
      number,
      qualified_ref: `school#${number}`,
      display_ref: `#${number}`,
    },
    title: `题库题目 ${number}`,
    kind,
    version_id: `v-${problemId}`,
    version: 1,
    binding_id: `binding-${problemId}`,
    policy_revision: 1,
  };
}

function makeExisting(overrides: Partial<DomainContest> = {}): DomainContest {
  const start = new Date(Date.now() + 60 * 60_000).toISOString();
  const end = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
  return {
    id: 'contest-1',
    public_id: 'ct-demo1234',
    domain_id: 'domain-1',
    revision: 3,
    title: '测试比赛',
    description: '比赛说明',
    start_time: start,
    end_time: end,
    ranking_visibility: 'participants',
    freeze_start_time: null,
    freeze_duration_seconds: 0,
    type: 'kaggle',
    config: { scoreboard_scope: 'self' },
    affect_global_ranking: false,
    created_by: 'teacher',
    announcement: '',
    status: 'pending',
    problem_count: 2,
    participant_count: 0,
    updated_at: start,
    secrecy_enabled: true,
    classrooms: [],
    ...overrides,
  };
}

const stubs = {
  UCard: { template: '<div><slot /></div>' },
  AdminFormField: { props: ['label', 'required'], template: '<div><label>{{ label }}</label><slot /></div>' },
  UInput: {
    props: ['modelValue', 'type', 'disabled', 'required', 'placeholder', 'min', 'max'],
    emits: ['update:modelValue'],
    template:
      '<input :value="modelValue" :disabled="disabled" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
  USelect: {
    props: ['modelValue', 'items', 'disabled', 'multiple', 'placeholder'],
    emits: ['update:modelValue'],
    template:
      '<select :disabled="disabled" @change="$emit(\'update:modelValue\', $event.target.value)"><option v-for="item in items" :key="item.value" :value="item.value">{{ item.label }}</option></select>',
  },
  MarkdownEditor: {
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template: '<textarea :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
  UCheckbox: {
    props: ['modelValue', 'label', 'disabled'],
    emits: ['update:modelValue'],
    template:
      '<input type="checkbox" :checked="modelValue" :disabled="disabled" @change="$emit(\'update:modelValue\', $event.target.checked)" />',
  },
  UAlert: { props: ['title', 'color'], template: '<p>{{ title }}<slot name="actions" /></p>' },
  UButton: {
    props: ['type', 'disabled', 'loading', 'icon', 'color', 'variant'],
    emits: ['click'],
    template:
      '<button :type="type ?? \'button\'" :disabled="disabled" @click="$emit(\'click\', $event)"><slot /></button>',
  },
  UPagination: { props: ['page', 'total', 'itemsPerPage'], template: '<div />' },
};

beforeEach(() => {
  vi.clearAllMocks();
  for (const [name, value] of Object.entries({ computed, ref, watch })) vi.stubGlobal(name, value);
  vi.stubGlobal('useAuth', () => ({ user: ref({ id: 'teacher' }) }));
  vi.stubGlobal('useDomainContests', () => api);
  vi.stubGlobal('useDomainProblems', () => problemApi);
  vi.stubGlobal('useWorkspace', () => ({
    domain: ref({ configuration: { features: { classroom: false } } }),
  }));
  vi.stubGlobal('useEducationApi', () => ({ classrooms: vi.fn().mockResolvedValue({ data: [] }) }));
  vi.stubGlobal('useWorkspaceActionScope', () => () => ({ slug: 'school', isCurrent: () => true }));
  vi.stubGlobal('useUnsavedChanges', vi.fn());
  vi.stubGlobal('navigateTo', navigateToMock);
  vi.stubGlobal(
    'useAsyncData',
    async (_key: unknown, load: () => Promise<unknown>) => ({
      data: ref(await load()),
      error: ref(null),
      refresh: vi.fn(),
    }),
  );
  api.problems.mockResolvedValue({
    data: [
      makeContestProblem('p1', 'A', 0, 'ai'),
      makeContestProblem('p2', 'B', 1, 'ai'),
    ],
  });
  api.update.mockResolvedValue({ data: { id: 'contest-1' } });
  api.create.mockResolvedValue({ data: { id: 'contest-new' } });
  problemApi.list.mockResolvedValue({
    items: [
      makeProblemSummary('p1', 1001, 'ai'),
      makeProblemSummary('p2', 1002, 'ai'),
      makeProblemSummary('p3', 1003, 'ai'),
    ],
    total: 3,
  });
});

async function renderForm(existing?: DomainContest) {
  const Wrapper = defineComponent({
    setup: () => () =>
      h(Suspense, null, {
        default: () => h(DomainContestForm, { slug: 'school', existing }),
      }),
  });
  const view = mount(Wrapper, { global: { stubs } });
  await flushPromises();
  return view;
}

describe('DomainContestForm', () => {
  it('编辑未开赛 Kaggle 比赛并调整赛时榜单时保留在选题目的 submission_limits', async () => {
    const existing = makeExisting({
      type: 'kaggle',
      config: { scoreboard_scope: 'self', submission_limits: { p1: 5, p2: 3 } },
    });
    const view = await renderForm(existing);

    const scoreboardSelect = view.findAll('select').find((select) => select.text().includes('完整榜'));
    expect(scoreboardSelect).toBeDefined();
    await scoreboardSelect!.setValue('full');

    await view.find('form').trigger('submit');
    await flushPromises();

    expect(api.update).toHaveBeenCalledTimes(1);
    const [slug, id, body, revision] = api.update.mock.calls[0];
    expect(slug).toBe('school');
    expect(id).toBe('contest-1');
    expect(revision).toBe(3);
    expect(body.config).toEqual({
      scoreboard_scope: 'full',
      submission_limits: { p1: 5, p2: 3 },
    });
    expect(navigateToMock).toHaveBeenCalledWith('/d/school/contests/contest-1');
  });

  it('编辑未开赛 OI 与 ACM 比赛时同样保留既有 submission_limits', async () => {
    api.problems.mockResolvedValue({
      data: [makeContestProblem('p1', 'A', 0, 'oi')],
    });
    const oiContest = makeExisting({
      type: 'oi',
      ranking_visibility: 'hidden',
      config: { submission_limits: { p1: 4 } },
    });
    const oiView = await renderForm(oiContest);
    await oiView.find('form').trigger('submit');
    await flushPromises();

    expect(api.update.mock.calls[0][2].config).toEqual({
      submission_limits: { p1: 4 },
    });
    oiView.unmount();

    const acmContest = makeExisting({
      type: 'acm',
      config: { penalty_minutes: 15, submission_limits: { p1: 6 } },
    });
    const acmView = await renderForm(acmContest);
    await acmView.find('form').trigger('submit');
    await flushPromises();

    expect(api.update.mock.calls[1][2].config).toEqual({
      penalty_minutes: 15,
      submission_limits: { p1: 6 },
    });
  });

  it('移除部分题目时丢弃被移除题目的 submission_limits，全部移除后不附带该字段', async () => {
    const existing = makeExisting({
      type: 'kaggle',
      config: { scoreboard_scope: 'self', submission_limits: { p1: 5, p2: 3 } },
    });
    const view = await renderForm(existing);

    // 移除第二道题 p2，保留 p1
    const removeButtons = view.findAll('button[aria-label="移除题目"]');
    expect(removeButtons).toHaveLength(2);
    await removeButtons[1]!.trigger('click');

    await view.find('form').trigger('submit');
    await flushPromises();

    expect(api.update.mock.calls[0][2].config).toEqual({
      scoreboard_scope: 'self',
      submission_limits: { p1: 5 },
    });

    // 先加入 p3，再移除 p1，此时没有任何保留题目带有限额
    const addP3 = view.findAll('button').find((button) => button.text().includes('#1003'));
    expect(addP3).toBeDefined();
    await addP3!.trigger('click');
    await view.find('button[aria-label="移除题目"]').trigger('click');

    await view.find('form').trigger('submit');
    await flushPromises();

    const secondConfig = api.update.mock.calls[1][2].config;
    expect(secondConfig).toEqual({ scoreboard_scope: 'self' });
    expect('submission_limits' in secondConfig).toBe(false);
  });

  it('原比赛没有 submission_limits 时正常提交且不注入多余字段', async () => {
    const existing = makeExisting({
      type: 'kaggle',
      config: { scoreboard_scope: 'full' },
    });
    const view = await renderForm(existing);

    await view.find('form').trigger('submit');
    await flushPromises();

    const sentConfig = api.update.mock.calls[0][2].config;
    expect(sentConfig).toEqual({ scoreboard_scope: 'full' });
    expect('submission_limits' in sentConfig).toBe(false);
  });

  it('已开赛锁定状态仅提交 title 与 description，不覆盖 config', async () => {
    const existing = makeExisting({
      status: 'running',
      type: 'kaggle',
      config: { scoreboard_scope: 'self', submission_limits: { p1: 5 } },
    });
    const view = await renderForm(existing);

    await view.find('form').trigger('submit');
    await flushPromises();

    expect(api.update).toHaveBeenCalledWith(
      'school',
      'contest-1',
      { title: '测试比赛', description: '比赛说明' },
      3,
    );
  });

  it('调整赛时社区静默策略时写入 community_silence_mode 并保留既有 submission_limits', async () => {
    const existing = makeExisting({
      type: 'kaggle',
      config: { scoreboard_scope: 'self', submission_limits: { p1: 5 } },
    });
    const view = await renderForm(existing);

    const silenceSelect = view.findAll('select').find((select) => select.text().includes('仅静默本场参赛选手'));
    expect(silenceSelect).toBeDefined();
    await silenceSelect!.setValue('contest_participants');

    await view.find('form').trigger('submit');
    await flushPromises();

    expect(api.update).toHaveBeenCalledTimes(1);
    expect(api.update.mock.calls[0][2].config).toEqual({
      scoreboard_scope: 'self',
      community_silence_mode: 'contest_participants',
      submission_limits: { p1: 5 },
    });
  });
});
