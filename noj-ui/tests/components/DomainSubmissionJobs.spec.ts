import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, ref, watch } from 'vue';
import DomainUpgradeAction from '~/components/submission/DomainUpgradeAction.vue';
import DomainRejudgeAction from '~/components/submission/DomainRejudgeAction.vue';
import { useDomainSubmissionJobs } from '~/composables/useDomainSubmissionJobs';
const api = { create: vi.fn() }, transport = { post: vi.fn(), get: vi.fn() }, navigate = vi.fn();
let permissions: string[] = [], current = true;
const stubs = {
  UButton: { props: ['disabled'], template: '<button :disabled="disabled"><slot /></button>' },
  UModal: { props: ['open'], template: '<div v-if="open"><slot name="body" /></div>' },
  UAlert: { props: ['title'], template: '<p>{{ title }}</p>' },
  AdminFormField: { template: '<label><slot /></label>' },
  USelect: {
    props: ['modelValue', 'items'],
    emits: ['update:modelValue'],
    template:
      '<select :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value)"><option v-for="item in items" :value="item.value">{{ item.label }}</option></select>',
  },
};
beforeEach(() => {
  vi.clearAllMocks();
  current = true;
  permissions = ['submission:create', 'submission:rejudge'];
  for (const [name, value] of Object.entries({ computed, ref, watch })) vi.stubGlobal(name, value);
  vi.stubGlobal(
    'useWorkspace',
    () => ({ can: (permission: string) => permissions.includes(permission), domain: ref({ status: 'active' }) }),
  );
  vi.stubGlobal('useWorkspaceActionScope', () => () => ({ slug: 'school', isCurrent: () => current }));
  vi.stubGlobal('useDomainSubmissionJobs', () => api);
  vi.stubGlobal('useApi', () => ({ api: transport }));
  vi.stubGlobal('navigateTo', navigate);
  api.create.mockResolvedValue({ data: { job_id: 'job-one' } });
});
describe('域内升级与重测任务', () => {
  it('四个API全部带路径域，受理保持上下文、固定原来源和幂等键', async () => {
    const jobs = useDomainSubmissionJobs();
    const body = {
      kind: 'upgrade' as const,
      submissions: [{ kind: 'submission' as const, id: 'source' }],
      context: 'practice' as const,
    };
    await jobs.create('school', body, 'same-key');
    await jobs.detail('school', 'job-one');
    await jobs.items('school', 'job-one', 3);
    await jobs.cancel('school', 'job-one');
    expect(transport.post).toHaveBeenCalledWith('/api/v1/domains/school/submission-jobs', body, {
      headers: { 'Idempotency-Key': 'same-key' },
      silent: true,
    });
    expect(transport.get).toHaveBeenCalledWith('/api/v1/domains/school/submission-jobs/job-one', { silent: true });
    expect(transport.get).toHaveBeenCalledWith('/api/v1/domains/school/submission-jobs/job-one/items', {
      query: { page: 3, per_page: 20 },
      silent: true,
    });
    expect(transport.post).toHaveBeenCalledWith('/api/v1/domains/school/submission-jobs/job-one/cancel', {}, {
      silent: true,
    });
  });
  it('个人升级失败保留原版本和原来源，重试不更换幂等键或转域', async () => {
    api.create.mockRejectedValue({ data: { error: '源题已不可使用', code: 'RESOURCE_UNAVAILABLE' } });
    const result = mount(DomainUpgradeAction, {
      props: {
        slug: 'school',
        source: { kind: 'submission', id: 'old-submission' },
        eligible: true,
        sourceVersion: 'old-version',
      },
      global: { stubs },
    });
    await result.get('button').trigger('click');
    await result.findAll('button').find((button) => button.text() === '确认创建升级任务')!.trigger('click');
    await flushPromises();
    expect(result.text()).toContain('原版本 old-version');
    expect(result.text()).toContain('源题已不可使用');
    await result.findAll('button').find((button) => button.text() === '确认创建升级任务')!.trigger('click');
    await flushPromises();
    expect(api.create.mock.calls[0]![1]).toEqual({
      kind: 'upgrade',
      submissions: [{ kind: 'submission', id: 'old-submission' }],
      context: 'practice',
    });
    expect(api.create.mock.calls[0]![2]).toBe(api.create.mock.calls[1]![2]);
    expect(navigate).not.toHaveBeenCalled();
  });
  it('隐藏、失效或未授权来源由入口eligible排除；角色无create/rejudge不展示动作', () => {
    const unavailable = mount(DomainUpgradeAction, {
      props: { slug: 'school', source: { kind: 'objective', id: 'answer' }, eligible: false },
      global: { stubs },
    });
    expect(unavailable.find('button').exists()).toBe(false);
    permissions = [];
    expect(
      mount(DomainRejudgeAction, {
        props: { slug: 'school', scope: { type: 'problem', problem_id: 'problem' }, label: '整题重测', eligible: true },
        global: { stubs },
      }).find('button').exists(),
    ).toBe(false);
    expect(api.create).not.toHaveBeenCalled();
  });
  it('当前所见作答版重测用specified单题映射，不隐式切换域策略', async () => {
    const result = mount(DomainRejudgeAction, {
      props: {
        slug: 'school',
        scope: { type: 'problem', problem_id: 'source-problem' },
        label: '整题重测',
        eligible: true,
        answerVersion: { problemId: 'source-problem', id: 'exact-old-version', version: 2 },
      },
      global: { stubs },
    });
    await result.get('button').trigger('click');
    await result.get('select').setValue('answer');
    await result.setProps({ answerVersion: { problemId: 'source-problem', id: 'newly-published-v3', version: 3 } });
    expect(result.text()).toContain('本页所见作答版 V2');
    await result.findAll('button').find((button) => button.text() === '确认受理重测任务')!.trigger('click');
    await flushPromises();
    expect(api.create).toHaveBeenCalledWith('school', {
      kind: 'rejudge',
      scope: { type: 'problem', problem_id: 'source-problem' },
      target: { mode: 'specified', versions: { 'source-problem': 'exact-old-version' } },
      policy_changes: [],
    }, expect.any(String));
    expect(navigate).toHaveBeenCalledWith('/d/school/submission-jobs/job-one');
  });
  it('组织视图的source_contest明确发送原比赛上下文，离域后不使用旧响应导航', async () => {
    const result = mount(DomainUpgradeAction, {
      props: {
        slug: 'school',
        source: { kind: 'submission', id: 'contest-source' },
        eligible: true,
        context: 'source_contest',
      },
      global: { stubs },
    });
    await result.get('button').trigger('click');
    current = false;
    await result.findAll('button').find((button) => button.text() === '确认创建升级任务')!.trigger('click');
    await flushPromises();
    expect(api.create.mock.calls[0]![1].context).toBe('source_contest');
    expect(navigate).not.toHaveBeenCalled();
  });
});
