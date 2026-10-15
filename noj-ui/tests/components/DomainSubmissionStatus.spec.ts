import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { computed } from 'vue';
import Status from '~/components/submission/DomainSubmissionStatus.vue';
import type { DomainSubmission } from '~/composables/useDomainSubmissions';
beforeEach(() => {
  vi.stubGlobal('computed', computed);
});
const submission = {
  id: 's',
  domain_id: 'd',
  resource_available: true,
  status: 'finished',
  result: { status: 'finished', verdict: 'AC', score: 10000 },
} as DomainSubmission;
const stubs = { UBadge: { template: '<span><slot /></span>' } };
describe('列表中的比赛结果摘要', () => {
  it('隐藏结果只显示已受理，即使缓存载荷包含分数也不会输出', () => {
    const view = mount(Status, {
      props: { submission: { ...submission, result_visibility: 'hidden' } },
      global: { stubs },
    });
    expect(view.text()).toBe('已受理');
    expect(view.text()).not.toContain('100');
    view.unmount();
  });
  it('可见摘要按整数百分比分数显示，未评测不伪造零分', async () => {
    const view = mount(Status, {
      props: { submission: { ...submission, result_visibility: 'summary' } },
      global: { stubs },
    });
    expect(view.text()).toContain('100.0 分');
    await view.setProps({ submission: { ...submission, status: 'pending', result: null } });
    expect(view.text()).not.toContain('0 分');
    view.unmount();
  });
});
