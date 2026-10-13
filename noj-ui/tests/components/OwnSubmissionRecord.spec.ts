import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import OwnSubmissionRecord from '~/components/submission/OwnSubmissionRecord.vue';
import OwnSubmissionSummary from '~/components/submission/OwnSubmissionSummary.vue';
import { useOwnSubmissions } from '~/composables/useOwnSubmissions';
import { useDomainObjectiveHistory } from '~/composables/useDomainObjectiveHistory';
import type { OwnSubmissionHistory } from '~/utils/own-submissions';
const entry = (): OwnSubmissionHistory => ({
  kind: 'submission',
  id: 's1',
  public_id: 'sub1',
  domain: { id: 'd1', slug: 'school', name: '学校', accessible: false },
  problem: { id: 'p1', title: '资源不可用' },
  reference: {
    problem_id: 'p1',
    source_domain_id: 'source',
    source_domain_slug: 'main',
    number: 1001,
    qualified_ref: 'main:1001',
    display_ref: 'main:1001',
    is_shared: true,
  },
  resource_available: false,
  contest_id: null,
  language: 'python3',
  file_name: null,
  created_at: '2026-10-13',
  submitted_version_id: 'v1',
  status: 'finished',
  result_visibility: 'summary',
  is_valid: true,
  is_accepted: true,
  result: { status: 'finished', score: 10000, verdict: null, time_ms: null, memory_kb: null },
  code: 'print("my code")',
});
const stubs = {
  UCard: { template: '<div><slot /></div>' },
  UButton: { props: ['to'], template: '<button :data-to="to"><slot /></button>' },
  UAlert: { props: ['title'], template: '<p>{{ title }}</p>' },
};
describe('本人原提交与成绩摘要', () => {
  it('失去域访问权仍显示原代码和授权摘要，不生成题面导航', () => {
    const view = mount(OwnSubmissionRecord, {
      props: { entry: entry(), offerDomainActions: true },
      global: { components: { OwnSubmissionSummary }, stubs },
    });
    expect(view.text()).toContain('print("my code")');
    expect(view.text()).toContain('100.0 分');
    expect(view.text()).toContain('当前无法进入此域');
    expect(view.findAll('button')).toHaveLength(0);
  });
  it('赛时hidden即使带有额外结果字段仍不渲染成绩和判定', () => {
    const hidden = entry();
    hidden.result_visibility = 'hidden';
    hidden.result!.verdict = 'WA';
    hidden.result!.time_ms = 666;
    const view = mount(OwnSubmissionSummary, { props: { entry: hidden }, global: { stubs } });
    expect(view.text()).toContain('提交已受理');
    expect(view.text()).not.toContain('100.0 分');
    expect(view.text()).not.toContain('WA');
    expect(view.text()).not.toContain('666');
  });
  it('当前仍可进入使用域时，操作导航明确进入该记录所属空间', () => {
    const accessible = entry();
    accessible.domain.accessible = true;
    accessible.resource_available = true;
    const view = mount(OwnSubmissionRecord, {
      props: { entry: accessible, offerDomainActions: true },
      global: { components: { OwnSubmissionSummary }, stubs },
    });
    expect(view.findAll('button').find((button) => button.text() === '进入所属空间提交详情')!.attributes('data-to'))
      .toBe('/d/school/submissions/s1');
  });
  it('平台失败不把尝试零分当作正式成绩', () => {
    const failed = entry();
    failed.is_valid = false;
    failed.result!.status = 'error';
    failed.result!.score = 0;
    const view = mount(OwnSubmissionSummary, { props: { entry: failed }, global: { stubs } });
    expect(view.text()).toContain('平台评测失败');
    expect(view.text()).not.toContain('0.0 分');
  });
  it('统一本人 API 请求不注入目标账号或偏好 Domain', async () => {
    const get = vi.fn();
    vi.stubGlobal('useApi', () => ({ api: { get } }));
    await useOwnSubmissions().list(2);
    await useOwnSubmissions().detail('objective', 'answer-one');
    expect(get).toHaveBeenCalledWith('/api/v1/me/submissions', { query: { page: 2, per_page: 30 }, silent: true });
    expect(get).toHaveBeenCalledWith('/api/v1/me/submissions/objective/answer-one', { silent: true });
  });
  it('域客观历史按使用域和题目过滤，不假定全账号分页DTO', async () => {
    const get = vi.fn().mockResolvedValue({ data: [], total: 42 });
    vi.stubGlobal('useApi', () => ({ api: { get } }));
    const result = await useDomainObjectiveHistory().list('school', 2, 'source-problem');
    await useDomainObjectiveHistory().detail('school', 'answer-one');
    expect(result.total).toBe(42);
    expect(get).toHaveBeenCalledWith('/api/v1/domains/school/objective-submissions', {
      query: { page: 2, per_page: 30, problem_id: 'source-problem' },
      silent: true,
    });
    expect(get).toHaveBeenCalledWith('/api/v1/domains/school/objective-submissions/answer-one', { silent: true });
  });
});
