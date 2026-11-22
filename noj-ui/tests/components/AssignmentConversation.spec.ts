import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, nextTick, ref, Suspense, watch } from 'vue';
import AssignmentConversation from '~/components/education/AssignmentConversation.vue';
const api = { feedback: vi.fn(), help: vi.fn(), feedbackDetail: vi.fn(), helpDetail: vi.fn(), ask: vi.fn() };
const stubs = {
  UCard: { template: '<div><slot /></div>' },
  UAlert: { props: ['title'], template: '<p>{{ title }}</p>' },
  UButton: { template: '<button><slot /></button>' },
  NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
  AssignmentHelpThread: { props: ['helpId'], template: '<div data-help-thread :data-help-id="helpId" />' },
  UTextarea: {
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template: '<textarea :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
};
beforeEach(() => {
  vi.stubGlobal('useUnsavedChanges', vi.fn());
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
  api.ask.mockResolvedValue({ data: {} });
});
function conversation(feedbackId?: string) {
  return conversationWith({ isStudent: true, canFeedback: false, canHelp: false, writable: false, feedbackId });
}
async function conversationWith(overrides: Record<string, unknown>) {
  const Wrapper = defineComponent({
    setup: () => () =>
      h(Suspense, null, {
        default: () =>
          h(AssignmentConversation, {
            slug: 'school',
            assignmentId: 'task',
            isStudent: false,
            canFeedback: false,
            canHelp: false,
            writable: true,
            ...overrides,
          }),
      }),
  });
  const view = mount(Wrapper, { global: { stubs } });
  await flushPromises();
  return view;
}
function buttonByText(view: ReturnType<typeof mount>, text: string) {
  return view.findAll('button').find((button) => button.text() === text);
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

describe('反馈表单的显式打开与角色栏位', () => {
  it('选中学生不会自动打开定向反馈表单，只有显式触发才展开', async () => {
    const view = await conversationWith({
      canFeedback: true,
      canHelp: true,
      targetUserId: 'student',
      targetUserName: '学生甲',
    });
    expect(view.findAll('textarea')).toHaveLength(0);
    expect(view.text()).toContain('反馈给 学生甲');
    await buttonByText(view, '写反馈')!.trigger('click');
    await nextTick();
    expect(view.findAll('textarea')).toHaveLength(1);
    view.unmount();
  });

  it('取消会丢弃草稿，重新打开时输入框为空', async () => {
    const view = await conversationWith({ canFeedback: true, canHelp: true, targetUserId: 'student' });
    await buttonByText(view, '写反馈')!.trigger('click');
    await nextTick();
    await view.get('textarea').setValue('这句反馈不该留下');
    expect(buttonByText(view, '取消并清空')).toBeTruthy();
    await buttonByText(view, '取消并清空')!.trigger('click');
    expect(view.findAll('textarea')).toHaveLength(0);
    await buttonByText(view, '写反馈')!.trigger('click');
    await nextTick();
    expect((view.get('textarea').element as HTMLTextAreaElement).value).toBe('');
    view.unmount();
  });

  it('没有反馈或求助权限的读者只看到自己可读的栏位', async () => {
    const feedbackOnly = await conversationWith({ canFeedback: true, canHelp: false });
    expect(feedbackOnly.text()).toContain('作业反馈');
    expect(feedbackOnly.text()).not.toContain('学生求助');
    feedbackOnly.unmount();
    const helpOnly = await conversationWith({ canFeedback: false, canHelp: true });
    expect(helpOnly.text()).toContain('学生求助');
    expect(helpOnly.text()).not.toContain('作业反馈');
    helpOnly.unmount();
  });
});

describe('求助与题目的关联', () => {
  it('求助列表与详情显示具体题目，未关联时明确说明', async () => {
    api.help.mockResolvedValueOnce({
      data: {
        data: [
          { id: 'h1', item_id: 'item', state: 'open', body: '这题怎么做' },
          { id: 'h2', item_id: null, state: 'open', body: '整体问题' },
        ],
        total: 2,
      },
    });
    const view = await conversationWith({
      canHelp: true,
      items: [{ id: 'item', displayRef: '1002', title: '两个数的最大值' }],
    });
    expect(view.text()).toContain('1002 · 两个数的最大值');
    expect(view.text()).toContain('未关联题目');
    view.unmount();
  });
});

describe('教练从求助跳转题目', () => {
  const items = [{ id: 'item', displayRef: '1002', qualifiedRef: 'school:1002', title: '两个数的最大值' }];
  const helpItems = {
    data: { data: [{ id: 'h1', item_id: 'item', state: 'open', body: '这题怎么做' }], total: 1 },
  };
  it('教练端求助关联题目是可点击的题目页链接', async () => {
    api.help.mockResolvedValueOnce(helpItems);
    const view = await conversationWith({ canHelp: true, items });
    expect(view.find('a[href="/d/school/problems/school:1002"]').exists()).toBe(true);
    expect(view.text()).toContain('1002 · 两个数的最大值');
    view.unmount();
  });
  it('学生端仍只显示题目文本，不额外跳走', async () => {
    api.help.mockResolvedValueOnce(helpItems);
    const view = await conversationWith({ isStudent: true, writable: false, items });
    expect(view.find('a[href="/d/school/problems/school:1002"]').exists()).toBe(false);
    expect(view.text()).toContain('1002 · 两个数的最大值');
    view.unmount();
  });
});

describe('求助在问题下方展开，可同时展开多条', () => {
  const helpItems = {
    data: {
      data: [
        { id: 'h1', item_id: null, state: 'open', body: '第一道题的问题' },
        { id: 'h2', item_id: null, state: 'open', body: '第二道题的问题' },
      ],
      total: 2,
    },
  };
  it('两条求助各自在问题下方展开回复区', async () => {
    api.help.mockResolvedValueOnce(helpItems);
    const view = await conversationWith({ canHelp: true });
    await view.get('button[aria-controls="help-detail-h1"]').trigger('click');
    await view.get('button[aria-controls="help-detail-h2"]').trigger('click');
    const threads = view.findAll('[data-help-thread]');
    expect(threads).toHaveLength(2);
    expect(threads.map((thread) => thread.attributes('data-help-id'))).toEqual(['h1', 'h2']);
    expect(view.get('button[aria-controls="help-detail-h1"]').attributes('aria-expanded')).toBe('true');
    await view.get('button[aria-controls="help-detail-h1"]').trigger('click');
    expect(view.findAll('[data-help-thread]')).toHaveLength(1);
    view.unmount();
  });
  it('通知深链会直接展开对应求助，而不是整列底部', async () => {
    api.help.mockResolvedValueOnce(helpItems);
    const view = await conversationWith({ canHelp: true, helpId: 'h2' });
    const threads = view.findAll('[data-help-thread]');
    expect(threads).toHaveLength(1);
    expect(threads[0]!.attributes('data-help-id')).toBe('h2');
    view.unmount();
  });
});
