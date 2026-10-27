import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, ref, Suspense, watch } from 'vue';
import ObjectivePage from '~/pages/d/[slug]/objective-submissions/[submissionId].vue';
import ContestProblemPage from '~/pages/d/[slug]/contests/[contestId]/problems/[label].vue';
import ContestSolvePage from '~/pages/d/[slug]/contests/[contestId]/solve/[label].vue';
import RankingPage from '~/pages/d/[slug]/contests/[contestId]/ranking.vue';
const contests = { detail: vi.fn(), ranking: vi.fn() }, answers = { problem: vi.fn() }, history = { detail: vi.fn() };
let polling: Array<{ intervalMs: { value: number | null }; fetcher: () => Promise<unknown> }>;
beforeEach(() => {
  vi.clearAllMocks();
  polling = [];
  for (const [name, value] of Object.entries({ computed, ref, watch })) vi.stubGlobal(name, value);
  vi.stubGlobal('definePageMeta', vi.fn());
  vi.stubGlobal('useSeoMeta', vi.fn());
  vi.stubGlobal('useRoute', () => ({ params: { contestId: 'contest', label: 'A', submissionId: 'answer' } }));
  vi.stubGlobal('useAuth', () => ({ user: ref({ id: 'student' }) }));
  vi.stubGlobal('useWorkspace', () => ({ slug: ref('school') }));
  vi.stubGlobal('useDomainContests', () => contests);
  vi.stubGlobal('useDomainContestAnswers', () => answers);
  vi.stubGlobal('useDomainObjectiveHistory', () => history);
  vi.stubGlobal('usePolling', (options: typeof polling[number]) => polling.push(options));
  vi.stubGlobal('useAsyncData', async (_key: unknown, read: () => Promise<unknown>) => {
    const data = ref<unknown>(null), error = ref<unknown>(null), status = ref('success');
    const refresh = async () => {
      try {
        data.value = await read();
        error.value = null;
      } catch (e) {
        error.value = e;
      }
    };
    await refresh();
    return { data, error, status, refresh };
  });
  contests.detail.mockResolvedValue({ data: { id: 'contest', status: 'pending', revision: 1, is_registered: true } });
  contests.ranking.mockResolvedValue({ data: [] });
});
async function view(page: typeof ObjectivePage) {
  const result = mount(defineComponent({ setup: () => () => h(Suspense, null, { default: () => h(page) }) }), {
    global: {
      stubs: {
        AsyncContent: { props: ['error'], template: '<section>{{ error }}<slot /></section>' },
        UCard: { template: '<section><slot /></section>' },
        UAlert: true,
        ClientOnly: true,
        MarkdownRenderer: true,
        UButton: { template: '<button><slot /></button>' },
        NuxtLink: { template: '<a><slot /></a>' },
        ProblemHeader: {
          template: '<header><slot name="leading" /><slot name="titleSuffix" /><slot name="actions" /></header>',
        },
        ProblemStatement: {
          props: ['content'],
          template: '<section><slot name="toolbar" /><slot name="after-content" /></section>',
        },
        ProblemSamples: true,
        DomainProblemSubmissions: true,
        DomainContestAnswer: { props: ['active'], template: '<p>可提交：{{ active }}</p>' },
        DomainCodeWorkspace: { props: ['contest'], template: '<p>可提交：{{ contest.active }}</p>' },
        OwnSubmissionRecord: {
          props: ['entry'],
          template: '<p>{{ entry.result_visibility }} {{ entry.result?.score }}</p>',
        },
      },
    },
  });
  await flushPromises();
  return result;
}
describe('比赛时间边界自动刷新', () => {
  it('开赛不增加 revision 时，已打开的题目错误页也重新读取并开放提交', async () => {
    answers.problem.mockRejectedValue({ data: { error: '比赛尚未开始' } });
    const result = await view(ContestProblemPage);
    expect(result.text()).toContain('比赛尚未开始');
    answers.problem.mockResolvedValue({ data: { title: '赛题', version_id: 'v1', label: 'A' } });
    contests.detail.mockResolvedValue({ data: { id: 'contest', status: 'running', revision: 1, is_registered: true } });
    await polling[0]!.fetcher();
    await flushPromises();
    expect(answers.problem).toHaveBeenCalledTimes(2);
    expect(result.text()).toContain('开始编码');
    result.unmount();
  });
  it('独立工作区在比赛结束时关闭提交，不因 revision 未变化继续受理', async () => {
    answers.problem.mockResolvedValue({
      data: {
        title: '赛题',
        version_id: 'v1',
        version: 1,
        label: 'A',
        problem_id: 'p',
        judge_type: 'oi',
        submission_mode: 'code',
        supported_languages: ['cc'],
        samples: [],
        reference: { problem_id: 'p', display_ref: '1001' },
      },
    });
    contests.detail.mockResolvedValue({
      data: { id: 'contest', title: '比赛', status: 'running', revision: 1, is_registered: true },
    });
    const result = await view(ContestSolvePage);
    expect(result.text()).toContain('可提交：true');
    contests.detail.mockResolvedValue({
      data: { id: 'contest', title: '比赛', status: 'ended', revision: 1, is_registered: true },
    });
    await polling[0]!.fetcher();
    await flushPromises();
    expect(result.text()).toContain('可提交：false');
    result.unmount();
  });
  it('客观题已即时评测但赛时隐藏时仍刷新，结束后显示允许摘要并停止轮询', async () => {
    history.detail.mockResolvedValue({ data: { result_visibility: 'hidden', status: 'finished' } });
    const result = await view(ObjectivePage);
    expect(polling[0]!.intervalMs.value).toBe(2000);
    history.detail.mockResolvedValue({
      data: { result_visibility: 'summary', status: 'finished', result: { score: 4200 } },
    });
    await polling[0]!.fetcher();
    await flushPromises();
    expect(result.text()).toContain('summary 4200');
    expect(polling[0]!.intervalMs.value).toBeNull();
    result.unmount();
  });
  it('开赛前打开的榜单随开始和结束更新，结束时重读最后实时结果并停止轮询', async () => {
    const result = await view(RankingPage);
    contests.detail.mockResolvedValue({ data: { status: 'running', revision: 1 } });
    await polling[0]!.fetcher();
    await flushPromises();
    expect(contests.ranking).toHaveBeenCalledTimes(2);
    expect(polling[1]!.intervalMs.value).toBe(5000);
    contests.detail.mockResolvedValue({ data: { status: 'ended', revision: 1 } });
    await polling[0]!.fetcher();
    await flushPromises();
    expect(contests.ranking).toHaveBeenCalledTimes(3);
    expect(polling[0]!.intervalMs.value).toBeNull();
    expect(polling[1]!.intervalMs.value).toBeNull();
    result.unmount();
  });
});
