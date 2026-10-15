import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, reactive, ref, Suspense, watch } from 'vue';
import AssignmentPage from '~/pages/d/[slug]/assignments/[assignmentId]/index.vue';

const actor = ref({ id: 'teacher', username: '教练' });
const route = reactive({ params: { assignmentId: 'task' }, query: {} });
const cell = { item_id: 'item', score: 0, status: 'below_target', updating: false };
beforeEach(() => {
  vi.clearAllMocks();
  actor.value = { id: 'teacher', username: '教练' };
  route.params.assignmentId = 'task';
  for (const [name, value] of Object.entries({ computed, ref, watch })) vi.stubGlobal(name, value);
  for (const name of ['definePageMeta', 'useSeoMeta', 'usePolling', 'useEducationNotifications']) {
    vi.stubGlobal(name, vi.fn());
  }
  vi.stubGlobal('useState', () => actor);
  vi.stubGlobal('useRoute', () => route);
  vi.stubGlobal('useWorkspace', () => ({
    slug: ref('school'),
    domain: ref({ status: 'active', configuration: { features: { classroom: true, assignment: true } } }),
  }));
  vi.stubGlobal('useWorkspaceActionScope', () => () => ({ slug: 'school', isCurrent: () => true }));
  vi.stubGlobal('useEducationApi', () => ({
    assignment: () =>
      Promise.resolve({
        data: {
          id: 'task',
          classroom_id: 'room',
          title: '作业',
          state: 'published',
          published_at: '2026-10-15T00:00:00Z',
        },
      }),
    classroom: () =>
      Promise.resolve({ data: { id: 'room', status: 'active', membership: { role: 'coach' }, capabilities: [] } }),
    matrix: () =>
      Promise.resolve({
        data: {
          rows: [{ user_id: 'student', username: '学生甲' }],
          items: [{ id: 'item', reference: { display_ref: '1001' } }],
          total: 1,
        },
      }),
  }));
  vi.stubGlobal('useAsyncData', async (_key: unknown, load: () => Promise<unknown>) => ({
    data: ref(await load()),
    error: ref(null),
    status: ref('success'),
    refresh: vi.fn(),
  }));
});
async function assignment() {
  const view = mount(defineComponent({ setup: () => () => h(Suspense, null, { default: () => h(AssignmentPage) }) }), {
    global: {
      stubs: {
        AsyncContent: { template: '<div><slot /></div>' },
        USlideover: { props: ['open'], template: '<aside v-if="open"><slot name="body" /></aside>' },
        AssignmentMatrix: defineComponent({
          emits: ['select'],
          setup: (_, { emit }) => () => h('button', { onClick: () => emit('select', 'student', cell) }, '查看学生'),
        }),
        AssignmentCellSubmissions: { template: '<p>读取中的学生提交</p>' },
        AssignmentConversation: { props: ['targetUserName'], template: '<p>反馈给{{ targetUserName }}</p>' },
        ClientOnly: true,
        UButton: true,
        USelect: true,
        UInput: true,
        AdminPageHeader: true,
        AdminFormField: true,
      },
    },
  });
  await flushPromises();
  return view;
}
describe('作业选择与身份刷新', () => {
  it('同一账号的新响应保留学生抽屉与反馈对象，真正换账号才清空', async () => {
    const view = await assignment();
    await view.get('button').trigger('click');
    expect(view.text()).toContain('读取中的学生提交');
    expect(view.text()).toContain('反馈给学生甲');
    actor.value = { ...actor.value, username: '刷新后的教练姓名' };
    await flushPromises();
    expect(view.text()).toContain('读取中的学生提交');
    expect(view.text()).toContain('反馈给学生甲');
    actor.value = { id: 'another-teacher', username: '另一教练' };
    await flushPromises();
    expect(view.text()).not.toContain('读取中的学生提交');
    expect(view.text()).not.toContain('反馈给学生甲');
    view.unmount();
  });
});
