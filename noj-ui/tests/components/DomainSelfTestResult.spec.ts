import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { computed } from 'vue';
import DomainSelfTestResult from '~/components/submission/DomainSelfTestResult.vue';
import type { DomainSelfTest } from '~/composables/useDomainSelfTests';
const record = {
  id: 'st',
  status: 'finished',
  score: 10000,
  resource_available: true,
  details: {
    oi: { subtasks: [{ cases: [{ case_id: 'custom_1', status: 'WA', stdout: 'own output', stderr: 'own stderr' }] }] },
  },
  output: null,
} as DomainSelfTest;
const stubs = {
  UCard: { template: '<div><slot /></div>' },
  UAlert: { props: ['title'], template: '<p>{{ title }}</p>' },
  SubmissionCaseResults: { template: '<p>case results</p>' },
};
beforeEach(() => vi.stubGlobal('computed', computed));
describe('自测允许字段与撤销资源呈现', () => {
  it('展示用户用例的实际输出和标准错误', () => {
    const view = mount(DomainSelfTestResult, { props: { record }, global: { stubs } });
    expect(view.text()).toContain('own output');
    expect(view.text()).toContain('own stderr');
  });
  it('源资源不可用时即使旧响应有输出也不展示详情', () => {
    const view = mount(DomainSelfTestResult, {
      props: { record: { ...record, resource_available: false } },
      global: { stubs },
    });
    expect(view.text()).toContain('只保留原自测和授权成绩摘要');
    expect(view.text()).not.toContain('own output');
    expect(view.text()).not.toContain('case results');
  });
});
