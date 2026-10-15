import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, ref, Suspense, watch } from 'vue';
import Detail from '~/pages/d/[slug]/problems/[reference].vue';
const read = vi.fn();
const origin = { assignment_id: 'task', assignment_item_id: 'item' };
beforeEach(() => {
  vi.clearAllMocks();
  for (const [name, value] of Object.entries({ computed, ref, watch })) vi.stubGlobal(name, value);
  vi.stubGlobal('definePageMeta', vi.fn());
  vi.stubGlobal('useSeoMeta', vi.fn());
  vi.stubGlobal('useRoute', () => ({ params: { reference: 'main:1001' }, query: origin }));
  vi.stubGlobal(
    'useWorkspace',
    () => ({ slug: ref('school'), domain: ref({ configuration: { features: { community: true } } }) }),
  );
  vi.stubGlobal('useAuth', () => ({ user: ref({ id: 'student' }) }));
  vi.stubGlobal('useDomainProblems', () => ({ detail: read }));
  vi.stubGlobal(
    'useAsyncData',
    async (_key: unknown, load: () => Promise<unknown>) => ({
      data: ref(await load()),
      status: ref('success'),
      error: ref(null),
      refresh: vi.fn(),
    }),
  );
});
async function view(kind = 'oi', mode = 'code') {
  read.mockResolvedValue({
    reference: { problem_id: 'p', number: 1001, display_ref: 'main:1001', is_shared: true },
    version_id: 'v1',
    version: 1,
    effective_version_mode: 'any',
    can_edit: false,
    content: { title: '共享题', kind, submission_mode: mode, description: '题面', samples: [], questions: [] },
  });
  const wrapper = mount(defineComponent({ setup: () => () => h(Suspense, null, { default: () => h(Detail) }) }), {
    global: {
      stubs: {
        AsyncContent: { template: '<div><slot /></div>' },
        UButton: { name: 'UButton', props: ['to'], template: '<button><slot /></button>' },
        ClientOnly: true,
        ProblemSamples: true,
        MarkdownRenderer: true,
        NuxtLink: { template: '<a><slot /></a>' },
        DomainProblemAnswer: { template: '<p>作答表单</p>' },
      },
    },
  });
  await flushPromises();
  return wrapper;
}
describe('阅读详情与独立作答入口', () => {
  it('代码题详情仅提供独立入口，保留使用域、来源题号和作业上下文', async () => {
    const wrapper = await view();
    expect(read).toHaveBeenCalledWith('school', 'main:1001');
    expect(wrapper.text()).not.toContain('作答表单');
    const start = wrapper.findAllComponents({ name: 'UButton' }).find((button) => button.text() === '开始编码')!;
    expect(start.props('to')).toEqual({ path: '/d/school/solve/main:1001', query: origin });
    expect(wrapper.text()).toContain('返回作业');
    wrapper.unmount();
  });
  it('客观题与产物在详情页作答，界面题打开独立界面', async () => {
    for (const [kind, mode] of [['objective', 'code'], ['ai', 'artifact'], ['ai', 'prediction']]) {
      const wrapper = await view(kind, mode);
      expect(wrapper.text()).toContain('作答表单');
      expect(wrapper.text()).not.toContain('开始编码');
      wrapper.unmount();
    }
    const wrapper = await view('ai', 'ui');
    expect(wrapper.text()).not.toContain('作答表单');
    expect(wrapper.text()).toContain('打开作答界面');
    wrapper.unmount();
  });
});
