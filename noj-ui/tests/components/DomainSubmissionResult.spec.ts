import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { computed } from 'vue';
import DomainSubmissionResult from '~/components/submission/DomainSubmissionResult.vue';
import type { DomainSubmission } from '~/composables/useDomainSubmissions';

const submission = {
  id: 's',
  resource_available: true,
  result_visibility: 'cases',
  status: 'finished',
  result: { status: 'Accepted', score: 9000, details: { secret: 'details' }, output: 'raw evaluator output' },
  attempts: [{ attempt_id: 'a', sequence: 1, version: 1, state: 'finished', result_kind: 'graded', score: 9000 }],
} as DomainSubmission;
const stubs = {
  UCard: { template: '<section><slot /></section>' },
  UAlert: { props: ['title'], template: '<div>{{ title }}</div>' },
  SubmissionCaseResults: { template: '<div>case details</div>' },
};
beforeEach(() => vi.stubGlobal('computed', computed));
describe('域提交结果呈现', () => {
  it('非OI完成结果不显示进行状态，平台失败不冒充答案错误', () => {
    const render = (value: Partial<DomainSubmission>) =>
      mount(DomainSubmissionResult, { props: { submission: { ...submission, ...value } }, global: { stubs } });
    for (const mode of ['artifact', 'prediction', 'ui', 'code']) {
      const view = render({ submission_mode: mode });
      expect(view.text()).toContain('评测完成');
      expect(view.text()).not.toContain('排队');
      expect(view.find('.animate-pulse').exists()).toBe(false);
    }
    const objective = render({ kind: 'objective' });
    expect(objective.text()).toContain('客观题已完成评分');
    const failed = render({ status: 'error', result: { status: 'error', score: 0 } });
    expect(failed.text()).toContain('平台评测失败');
    expect(failed.text()).toContain('不代表答案错误');
    for (const [state, label] of [['pending', '等待评测'], ['judging', '正在评测']]) {
      const view = render({ status: state, result: null, attempts: [] });
      expect(view.text()).toContain(label);
      expect(view.find('.animate-pulse').exists()).toBe(true);
    }
  });
  it('历史平台失败不覆盖当前正式完成结果', () => {
    const view = mount(DomainSubmissionResult, {
      props: {
        submission: {
          ...submission,
          attempts: [{
            attempt_id: 'old',
            sequence: 1,
            version: 1,
            state: 'finished',
            result_kind: 'platform_error',
            score: 0,
          }],
        },
      },
      global: { stubs },
    });
    expect(view.text()).toContain('评测完成');
    expect(view.text()).not.toContain('平台评测失败');
  });
  it('正式 OI 判定使用 AC/WA/CE，不将已评测当作通过', () => {
    for (const verdict of ['AC', 'WA', 'CE']) {
      const view = mount(DomainSubmissionResult, {
        props: {
          submission: {
            ...submission,
            result_visibility: 'summary',
            result: { status: 'finished', score: 0, verdict },
          },
        },
        global: { stubs },
      });
      expect(view.text()).toContain(`${verdict} ·`);
      expect(view.text()).not.toContain('已评测');
    }
  });
  it('ACM 汇总显示允许的编译诊断，IOI 子任务只在 cases 模式展示', () => {
    const details = {
      oi: {
        verdict: 'CE',
        compile_error: 'main.cpp: expected semicolon',
        subtasks: [{ id: 'group1', status: 'WA', score: 6000, max_score: 10000 }],
      },
    };
    const render = (visibility: DomainSubmission['result_visibility'], available = true) =>
      mount(DomainSubmissionResult, {
        props: {
          submission: {
            ...submission,
            result_visibility: visibility,
            resource_available: available,
            result: { status: 'finished', score: 6000, details },
          },
        },
        global: { stubs },
      });
    const summary = render('summary');
    expect(summary.text()).toContain('编译诊断');
    expect(summary.text()).toContain('expected semicolon');
    expect(summary.text()).not.toContain('group1');
    const cases = render('cases');
    expect(cases.text()).toContain('group1');
    expect(cases.text()).toContain('60.0 / 100.0');
    for (const view of [render('hidden'), render('cases', false)]) {
      expect(view.text()).not.toContain('expected semicolon');
      expect(view.text()).not.toContain('group1');
    }
  });
  it('隐藏时不展示任何结果、输出、测试点或评测沿革', () => {
    const view = mount(DomainSubmissionResult, {
      props: { submission: { ...submission, result_visibility: 'hidden' } },
      global: { stubs },
    });
    expect(view.text()).toBe('提交已受理，比赛规定的结果暂未公开');
    expect(view.text()).not.toContain('90');
    expect(view.text()).not.toContain('case details');
  });
  it('汇总模式保留分数，资源撤销或严格模式不展示测试点和原始输出', () => {
    for (const variant of [{ result_visibility: 'summary' as const }, { resource_available: false }]) {
      const view = mount(DomainSubmissionResult, {
        props: { submission: { ...submission, ...variant } },
        global: { stubs },
      });
      expect(view.text()).toContain('90');
      expect(view.text()).not.toContain('case details');
      expect(view.text()).not.toContain('raw evaluator output');
    }
  });
});
