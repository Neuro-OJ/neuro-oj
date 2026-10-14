import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, ref, Suspense, watch } from 'vue';
import AssignmentConversation from '~/components/education/AssignmentConversation.vue';
const api = { feedback: vi.fn(), help: vi.fn(), feedbackDetail: vi.fn(), helpDetail: vi.fn() };
const stubs = {
  UCard: { template: '<div><slot /></div>' },
  UAlert: { props: ['title'], template: '<p>{{ title }}</p>' },
  UButton: { template: '<button><slot /></button>' },
  UTextarea: { template: '<textarea />' },
};
beforeEach(() => {
  vi.clearAllMocks();
  for (const [name, value] of Object.entries({ computed, ref, watch })) vi.stubGlobal(name, value);
  vi.stubGlobal('useState', () => ref({ id: 'student' }));
  vi.stubGlobal('useEducationApi', () => api);
  vi.stubGlobal('useWorkspaceActionScope', () => () => ({ slug: 'school', isCurrent: () => true }));
  vi.stubGlobal('useAsyncData', async (_key: unknown, load: () => Promise<unknown>) => {
    try {
      return { data: ref(await load()), error: ref(null), status: ref('success'), refresh: vi.fn() };
    } catch (e) {
      return { data: ref(null), error: ref(e), status: ref('error'), refresh: vi.fn() };
    }
  });
  api.feedback.mockResolvedValue({ data: { data: [], total: 0 } });
  api.help.mockResolvedValue({ data: { data: [], total: 0 } });
});
async function conversation(feedbackId?: string) {
  const Wrapper = defineComponent({
    setup: () => () =>
      h(Suspense, null, {
        default: () =>
          h(AssignmentConversation, {
            slug: 'school',
            assignmentId: 'task',
            isStudent: true,
            canFeedback: false,
            canHelp: false,
            writable: false,
            feedbackId,
          }),
      }),
  });
  const view = mount(Wrapper, { global: { stubs } });
  await flushPromises();
  return view;
}
describe('通知点击后的互动读取', () => {
  it('普通作业页没有通知定位时正常渲染，不读取空反馈或推断授权', async () => {
    const view = await conversation();
    expect(view.text()).toContain('暂无反馈');
    expect(api.feedbackDetail).not.toHaveBeenCalled();
    view.unmount();
  });
  it('个人反馈明确显示服务端授权返回的目标姓名', async () => {
    api.feedback.mockResolvedValueOnce({
      data: {
        data: [{ id: 'note', author_name: '老师', target_user_id: 'student', target_name: '小明', body: '检查边界' }],
        total: 1,
      },
    });
    const view = await conversation();
    expect(view.text()).toContain('给 小明');
    expect(view.text()).not.toContain('学生个人反馈');
    view.unmount();
  });
  it('反馈不在第一页时仍通过域内单条接口读取，拒绝后只显示授权错误', async () => {
    api.feedbackDetail.mockResolvedValueOnce({ data: { id: 'older', body: '此前的个人反馈', author_name: '老师' } });
    const first = await conversation('older');
    expect(api.feedbackDetail).toHaveBeenCalledWith('school', 'task', 'older');
    expect(first.text()).toContain('此前的个人反馈');
    first.unmount();
    api.feedbackDetail.mockRejectedValueOnce({ statusCode: 404, data: { error: '反馈不存在或不可访问' } });
    const denied = await conversation('other-student');
    expect(denied.text()).toContain('反馈不存在或不可访问');
    expect(denied.text()).not.toContain('此前的个人反馈');
    denied.unmount();
  });
});
