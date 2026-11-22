import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, onMounted, ref, Suspense, watch } from 'vue';
import DomainSelfTestPanel from '~/components/feature/DomainSelfTestPanel.vue';
import type { DomainProblemDetail } from '~/utils/domain-problems';
const api = { create: vi.fn(), detail: vi.fn(), cancel: vi.fn() };
const refresh = vi.fn();
const problem = {
  reference: { problem_id: 'p', display_ref: 'main:1001' },
  content: { kind: 'oi', samples: [{ input: '1', output: '' }] },
} as DomainProblemDetail;
const stubs = {
  UButton: { props: ['disabled'], template: '<button :disabled="disabled"><slot /></button>' },
  UCheckbox: { template: '<input type="checkbox" />' },
  DomainSelfTestResult: { template: '<p>self test result</p>' },
  UAlert: { props: ['title'], template: '<p>{{ title }}<slot name="actions" /></p>' },
};
beforeEach(() => {
  vi.clearAllMocks();
  for (const [name, value] of Object.entries({ computed, ref, onMounted, watch })) vi.stubGlobal(name, value);
  vi.stubGlobal('useAuth', () => ({ user: ref({ id: 'student' }) }));
  vi.stubGlobal('useDomainSelfTests', () => api);
  vi.stubGlobal('useWorkspaceActionScope', () => () => ({ slug: 'school', isCurrent: () => true }));
  vi.stubGlobal('usePolling', () => ({}));
  vi.stubGlobal(
    'useAsyncData',
    () => ({
      data: ref({ data: { id: 'st1', status: 'judging', resource_available: true } }),
      error: ref(null),
      refresh,
    }),
  );
  api.create.mockResolvedValue({ data: { id: 'st1', status: 'pending' } });
  api.cancel.mockResolvedValue({ data: { cancel_requested: true } });
});
async function panel() {
  const Wrapper = defineComponent({
    setup: () => () =>
      h(Suspense, null, {
        default: () =>
          h(DomainSelfTestPanel, {
            slug: 'school',
            problem,
            code: 'print(1)',
            language: 'python3',
            versionId: 'v1',
            writable: true,
          }),
      }),
  });
  const view = mount(Wrapper, { global: { stubs } });
  await flushPromises();
  return view;
}
describe('域 OI 自测', () => {
  it('使用目标域、所见版本和用户样例，空预期输出保留为空字符串', async () => {
    const view = await panel();
    await view.findAll('button').find((button) => button.text() === '运行自测')!.trigger('click');
    await flushPromises();
    expect(api.create).toHaveBeenCalledWith('school', 'main:1001', {
      version_id: 'v1',
      language: 'python3',
      code: 'print(1)',
      cases: [{ id: 'sample_1', input: '1', expected_output: '' }],
    });
    expect(view.text()).toContain('自测不计入正式成绩或作业进度');
  });
  it('取消请求使用同域运行 ID，仍重读服务器最终状态', async () => {
    const view = await panel();
    await view.findAll('button').find((button) => button.text() === '运行自测')!.trigger('click');
    await flushPromises();
    await view.findAll('button').find((button) => button.text() === '取消运行')!.trigger('click');
    await flushPromises();
    expect(api.cancel).toHaveBeenCalledWith('school', 'st1');
    expect(refresh).toHaveBeenCalled();
  });
});
