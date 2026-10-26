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
