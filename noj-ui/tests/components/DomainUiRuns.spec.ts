import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, ref, Suspense, watch } from 'vue';
import DomainUiRuns from '~/components/feature/DomainUiRuns.vue';
const submissions = { list: vi.fn(), detail: vi.fn() }, selfTests = { list: vi.fn(), detail: vi.fn() };
const scope = ref('school');
const formal = {
  id: 's1',
  language: 'ui',
  created_at: '2026-10-13T00:01:00Z',
  status: 'finished',
  code: '{"prompt":"before"}',
  result_visibility: 'summary',
  result: { status: 'accepted', score: 8000 },
};
const test = {
  id: 't1',
  language: 'ui',
  created_at: '2026-10-13T00:00:00Z',
  status: 'finished',
  code: '{"prompt":"practice"}',
  result_status: 'accepted',
  score: 5000,
  resource_available: true,
};
const pagination = { page: 1, per_page: 30, total: 1, total_pages: 1 };
beforeEach(() => {
  vi.clearAllMocks();
  scope.value = 'school';
  for (const [name, value] of Object.entries({ computed, ref, watch })) vi.stubGlobal(name, value);
  vi.stubGlobal('useAuth', () => ({ user: ref({ id: 'student' }) }));
  vi.stubGlobal('useDomainSubmissions', () => submissions);
  vi.stubGlobal('useDomainSelfTests', () => selfTests);
  vi.stubGlobal('usePolling', () => ({}));
  vi.stubGlobal('useWorkspaceActionScope', () => () => {
    const target = scope.value;
    return { slug: target, isCurrent: () => scope.value === target };
  });
  vi.stubGlobal('useAsyncData', async (_key: unknown, load: () => Promise<unknown>) => {
    const data = ref(await load());
    return {
      data,
      error: ref(null),
      refresh: async () => {
        data.value = await load();
      },
    };
  });
  submissions.list.mockResolvedValue({ data: [formal], pagination });
  submissions.detail.mockResolvedValue({ data: formal });
  selfTests.list.mockResolvedValue({ data: [test], pagination });
  selfTests.detail.mockResolvedValue({ data: test });
});
async function view(contestId?: string) {
  const code = ref('{"prompt":"current"}');
  const Wrapper = defineComponent({
    setup: () => () =>
      h(Suspense, null, {
        default: () =>
          h(DomainUiRuns, {
            slug: 'school',
            problemId: 'source-id',
            reference: 'main:1001',
            contestId,
            submissionId: '',
            selfTest: null,
            code: code.value,
            writable: true,
            onRestore: (value: string) => {
              code.value = value;
            },
          }),
      }),
  });
  const wrapper = mount(Wrapper, {
    global: {
      stubs: {
        UButton: { props: ['disabled'], template: '<button :disabled="disabled"><slot /></button>' },
        UAlert: { props: ['title'], template: '<p>{{ title }}</p>' },
      },
    },
  });
  await flushPromises();
  return { wrapper, runs: wrapper.findComponent(DomainUiRuns) };
}
describe('Domain界面运行历史与SDK结果', () => {
  it('本人域目录合并持久提交与自测，原参数可对比、回滚并撤销', async () => {
    const { wrapper, runs } = await view();
    expect(submissions.list).toHaveBeenCalledWith('school', 1, { problem_id: 'source-id', contest_id: undefined });
    expect(selfTests.list).toHaveBeenCalledWith('school', 'main:1001', 1);
    expect(runs.emitted('result')!.at(-1)![0]).toMatchObject({ kind: 'submit', score: 80 });
    await wrapper.findAll('button').filter((button) => button.text() === '对比参数')[0]!.trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('- {"prompt":"before"}');
    expect(wrapper.text()).toContain('+ {"prompt":"current"}');
    await wrapper.findAll('button').filter((button) => button.text() === '回滚参数')[0]!.trigger('click');
    await flushPromises();
    expect(runs.emitted('restore')!.at(-1)).toEqual(['{"prompt":"before"}']);
    await wrapper.findAll('button').find((button) => button.text() === '撤销回滚')!.trigger('click');
    expect(runs.emitted('restore')!.at(-1)).toEqual(['{"prompt":"current"}']);
  });
  it('比赛仅查询本场提交，hidden保持中性状态不经SDK泄漏分数，也不取练习自测', async () => {
    submissions.detail.mockResolvedValue({
      data: { ...formal, result_visibility: 'hidden', result: { status: 'WA', score: 9900, output: 'secret' } },
    });
    const { wrapper, runs } = await view('contest');
    expect(submissions.list).toHaveBeenCalledWith('school', 1, { problem_id: 'source-id', contest_id: 'contest' });
    expect(selfTests.list).not.toHaveBeenCalled();
    expect(runs.emitted('result')!.at(-1)![0]).toEqual({
      kind: 'submit',
      status: 'accepted',
      label: '已受理',
      score: null,
    });
    expect(wrapper.text()).not.toContain('99 分');
    expect(wrapper.text()).not.toContain('secret');
  });
  it('刷新后最近的持久自测仍可回推SDK，切域后的旧参数响应不回滚新域草稿', async () => {
    selfTests.detail.mockResolvedValue({ data: { ...test, created_at: '2026-10-13T00:02:00Z' } });
    const { wrapper, runs } = await view();
    expect(runs.emitted('result')!.at(-1)![0]).toMatchObject({ kind: 'self-test', score: 50 });
    submissions.detail.mockImplementationOnce(() => {
      scope.value = 'other';
      return Promise.resolve({ data: formal });
    });
    await wrapper.findAll('button').filter((button) => button.text() === '回滚参数')[0]!.trigger('click');
    await flushPromises();
    expect(runs.emitted('restore')).toBeUndefined();
  });
});
