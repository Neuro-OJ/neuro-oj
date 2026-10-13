import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, ref, Suspense, watch } from 'vue';
import JobPage from '~/pages/d/[slug]/submission-jobs/[jobId].vue';
import type { DomainSubmissionJob } from '~/utils/domain-submission-jobs';
const api = { detail: vi.fn(), items: vi.fn(), cancel: vi.fn() };
let polling: { intervalMs: { value: number | null }; fetcher: () => Promise<void> };
const job = (): DomainSubmissionJob => ({
  id: 'job-one',
  domain_id: 'school-id',
  actor_id: 'owner',
  kind: 'upgrade',
  status: 'running',
  created_at: '2026-10-13',
  finished_at: null,
  total_items: 1,
  counts: { pending: 1 },
  cancel_requested: false,
});
beforeEach(() => {
  vi.clearAllMocks();
  for (const [name, value] of Object.entries({ computed, ref, watch })) vi.stubGlobal(name, value);
  vi.stubGlobal('definePageMeta', vi.fn());
  vi.stubGlobal('useSeoMeta', vi.fn());
  vi.stubGlobal('useAuth', () => ({ user: ref({ id: 'owner' }) }));
  vi.stubGlobal('useRoute', () => ({ params: { jobId: 'job-one' } }));
  vi.stubGlobal('useWorkspace', () => ({ slug: ref('school'), domain: ref({ status: 'active' }), can: () => false }));
  vi.stubGlobal('useWorkspaceActionScope', () => () => ({ slug: 'school', isCurrent: () => true }));
  vi.stubGlobal('useDomainSubmissionJobs', () => api);
  vi.stubGlobal('usePolling', (options: typeof polling) => {
    polling = options;
  });
  vi.stubGlobal('useAsyncData', async (_key: unknown, handler: () => Promise<unknown>) => {
    const data = ref<unknown>(null), error = ref<unknown>(null);
    const refresh = async () => {
      try {
        data.value = await handler();
        error.value = null;
      } catch (e) {
        error.value = e;
      }
    };
    await refresh();
    return { data, error, status: ref('success'), refresh };
  });
  api.detail.mockResolvedValue({ data: job() });
  api.items.mockResolvedValue({
    data: [{
      id: 'item-one',
      ordinal: 0,
      source_kind: 'submission',
      source_id: 'old-code',
      problem_id: 'source-problem',
      target_version_id: 'frozen-v2',
      target_version_ref: 'frozen-v2',
      status: 'pending',
      attempt_id: null,
      reason_code: null,
      reason_message: null,
      result_submission_id: null,
      domain_id: 'school-id',
      domain_problem_binding_id: 'binding',
    }],
    pagination: { total: 60, total_pages: 3 },
  });
  api.cancel.mockResolvedValue({
    data: { id: 'job-one', domain_id: 'school-id', status: 'running', cancel_requested: true },
  });
});
async function view() {
  const Wrapper = defineComponent({ setup: () => () => h(Suspense, null, { default: () => h(JobPage) }) });
  const result = mount(Wrapper, {
    global: {
      stubs: {
        UButton: { props: ['to'], template: '<button :data-to="to"><slot /></button>' },
        AsyncContent: { props: ['error'], template: '<div><p v-if="error">{{ error }}</p><slot /></div>' },
        UCard: { template: '<div><slot /></div>' },
        AdminPageHeader: true,
        UBadge: { template: '<span><slot /></span>' },
        UAlert: { props: ['title'], template: '<p>{{ title }}</p>' },
        UPagination: {
          props: ['page'],
          emits: ['update:page'],
          template: '<button @click="$emit(\'update:page\', 2)">第二页</button>',
        },
      },
    },
  });
  await flushPromises();
  return result;
}
describe('域任务详情生命周期', () => {
  it('来源和目标版本保留，条目独立分页，自动读取至多60轮', async () => {
    const result = await view();
    expect(api.items).toHaveBeenCalledWith('school', 'job-one', 1);
    expect(result.text()).toContain('old-code');
    expect(result.text()).toContain('frozen-v2');
    expect(result.text()).toContain('自动刷新最多两分钟');
    for (let n = 0; n < 60; n++) await polling.fetcher();
    expect(polling.intervalMs.value).toBe(null);
  });
  it('任务不可访问时不请求条目，不继续自动读取', async () => {
    api.detail.mockRejectedValue({ data: { error: '任务不存在', code: 'NOT_FOUND' } });
    const result = await view();
    expect(result.text()).toContain('任务不存在');
    expect(api.items).not.toHaveBeenCalled();
    expect(polling.intervalMs.value).toBe(null);
  });
  it('升级结果定位符链接仍使用任务所属域和正确客观类型', async () => {
    api.items.mockResolvedValue({
      data: [{
        id: 'item',
        ordinal: 0,
        source_kind: 'objective',
        source_id: 'old-answer',
        problem_id: 'paper',
        target_version_id: 'v2',
        status: 'succeeded',
        result_submission_id: 'new-answer',
        reason_message: null,
      }],
      pagination: { total: 1, total_pages: 1 },
    });
    const result = await view();
    expect(result.findAll('button').find((button) => button.text() === '查看升级后的新提交')!.attributes('data-to'))
      .toBe('/d/school/objective-submissions/new-answer');
  });
  it('慢请求不能将自动刷新延长为无限读取，过两分钟后停止', async () => {
    const started = Date.now();
    await view();
    const time = vi.spyOn(Date, 'now').mockReturnValue(started + 121_000);
    await polling.fetcher();
    expect(polling.intervalMs.value).toBe(null);
    time.mockRestore();
  });
  it('取消只调用当前域取消接口并刷新，已受理评测仍展示进行状态', async () => {
    const result = await view();
    api.detail.mockResolvedValue({ data: { ...job(), cancel_requested: true } });
    await result.findAll('button').find((button) => button.text() === '取消未派发条目')!.trigger('click');
    await flushPromises();
    expect(api.cancel).toHaveBeenCalledWith('school', 'job-one');
    expect(result.text()).toContain('已请求取消尚未派发的条目');
    expect(result.text()).toContain('执行中');
  });
});
