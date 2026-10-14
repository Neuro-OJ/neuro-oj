import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, ref, Suspense, watch } from 'vue';
import AssignmentPage from '~/pages/d/[slug]/assignments/[assignmentId]/index.vue';
import TeachingPage from '~/pages/d/[slug]/teaching.vue';
import LearningPage from '~/pages/d/[slug]/my-learning.vue';
const api = { assignment: vi.fn(), classroom: vi.fn(), matrix: vi.fn(), progress: vi.fn(), dashboard: vi.fn() };
let events: Array<() => Promise<void>>;
beforeEach(() => {
  vi.clearAllMocks();
  events = [];
  for (const [name, value] of Object.entries({ computed, ref, watch })) vi.stubGlobal(name, value);
  vi.stubGlobal('definePageMeta', vi.fn());
  vi.stubGlobal('useSeoMeta', vi.fn());
  vi.stubGlobal('useRoute', () => ({ params: { assignmentId: 'task' }, query: {} }));
  vi.stubGlobal('useState', () => ref({ id: 'teacher' }));
  vi.stubGlobal('useAuth', () => ({ user: ref({ id: 'teacher' }) }));
  vi.stubGlobal(
    'useWorkspace',
    () => ({
      slug: ref('school'),
      domain: ref({ status: 'active', configuration: { features: { classroom: true, assignment: true } } }),
    }),
  );
  vi.stubGlobal('useEducationApi', () => api);
  vi.stubGlobal('useWorkspaceActionScope', () => () => ({ slug: 'school', isCurrent: () => true }));
  vi.stubGlobal('usePolling', vi.fn());
  vi.stubGlobal('useEducationNotifications', (refresh: () => Promise<void>) => {
    events.push(refresh);
  });
  vi.stubGlobal('useAsyncData', async (_key: unknown, handler: () => Promise<unknown>) => {
    const data = ref<unknown>(null), error = ref<unknown>(null);
    const refresh = async () => {
      try {
        data.value = await handler();
        error.value = null;
      } catch (failure) {
        error.value = failure;
      }
    };
    await refresh();
    return { data, error, status: ref('success'), refresh };
  });
  api.assignment.mockResolvedValue({
    data: {
      id: 'task',
      classroom_id: 'class',
      title: 'Task',
      state: 'published',
      published_at: '2026-10-14T10:00:00Z',
      deadline_at: null,
    },
  });
  api.classroom.mockResolvedValue({
    data: { id: 'class', status: 'active', manages_domain: true, membership: { role: 'coach' } },
  });
  api.matrix.mockResolvedValue({ data: { items: [], rows: [], total: 0, updating: false } });
  api.progress.mockResolvedValue({ data: { items: [], cells: [], updating: false } });
  api.dashboard.mockResolvedValue({ data: { assignments: [], help_requests: [], total: 0, per_page: 50 } });
});
async function page(component: typeof AssignmentPage) {
  const view = mount(defineComponent({ setup: () => () => h(Suspense, null, { default: () => h(component) }) }), {
    global: {
      stubs: {
        UCard: { template: '<div><slot /></div>' },
        UButton: { template: '<button><slot /></button>' },
        AdminPageHeader: true,
        AsyncContent: { template: '<div><slot /></div>' },
        AssignmentMatrix: { name: 'AssignmentMatrix', template: '<div data-testid="matrix" />' },
        TeachingDashboard: true,
        AssignmentConversation: true,
        AssignmentHistory: true,
        USlideover: true,
        ClientOnly: true,
      },
    },
  });
  await flushPromises();
  return view;
}
describe('教学页面的持久事件刷新', () => {
  it('稳定矩阵收到新事件后重新读取任务、班级和当前域成绩，不依赖旧 updating 标志', async () => {
    const view = await page(AssignmentPage);
    api.assignment.mockClear();
    api.classroom.mockClear();
    api.matrix.mockClear();
    await events[0]!();
    await flushPromises();
    expect(api.assignment).toHaveBeenCalledWith('school', 'task');
    expect(api.classroom).toHaveBeenCalledWith('school', 'class');
    expect(api.matrix).toHaveBeenCalledWith('school', 'task', expect.objectContaining({ scope: 'on_time' }));
    view.unmount();
  });
  it('关系撤销后停止读取教师矩阵，隐藏原教师视图', async () => {
    const view = await page(AssignmentPage);
    expect(view.find('[data-testid="matrix"]').exists()).toBe(true);
    api.matrix.mockClear();
    api.classroom.mockResolvedValue({
      data: { id: 'class', status: 'active', manages_domain: false, membership: null },
    });
    await events[0]!();
    await flushPromises();
    expect(api.matrix).not.toHaveBeenCalled();
    expect(view.find('[data-testid="matrix"]').exists()).toBe(false);
    view.unmount();
  });
  it('教师工作台和我的学习都在新事件后重读本域任务', async () => {
    for (const [component, mode] of [[TeachingPage, 'teaching'], [LearningPage, 'my-learning']] as const) {
      events = [];
      const view = await page(component);
      api.dashboard.mockClear();
      await events[0]!();
      expect(api.dashboard).toHaveBeenCalledWith('school', mode, 1);
      view.unmount();
    }
  });
});
