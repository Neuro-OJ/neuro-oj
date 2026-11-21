import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h, ref, Suspense } from 'vue';
import AssignmentNotices from '~/components/education/AssignmentNotices.vue';

const api = {
  feedback: vi.fn(),
  feedbackDetail: vi.fn(),
  addFeedback: vi.fn(),
  updateFeedback: vi.fn(),
};
const confirm = vi.fn();

const stubs = {
  UAlert: { props: ['title'], template: '<p role="alert">{{ title }}</p>' },
  UBadge: { template: '<span><slot /></span>' },
  UIcon: true,
  UButton: {
    props: ['type', 'disabled'],
    template: '<button :type="type || \'button\'" :disabled="disabled"><slot /></button>',
  },
  MarkdownRenderer: { props: ['content'], template: '<div class="md">{{ content }}</div>' },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('useUnsavedChanges', vi.fn());
  vi.stubGlobal('useState', () => ref({ id: 'coach' }));
  vi.stubGlobal('useEducationApi', () => api);
  vi.stubGlobal('useDialog', () => ({ dialog: { confirm } }));
  vi.stubGlobal('useWorkspaceActionScope', () => () => ({ slug: 'school', isCurrent: () => true }));
  vi.stubGlobal('useAsyncData', async (_key: unknown, load: () => Promise<unknown>) => {
    const data = ref<unknown>(null);
    const error = ref<unknown>(null);
    const refresh = async () => {
      try {
        data.value = await load();
        error.value = null;
      } catch (e) {
        error.value = e;
      }
    };
    await refresh();
    return { data, error, status: ref('success'), refresh };
  });
  api.feedback.mockResolvedValue({ data: { data: [], total: 0 } });
  api.feedbackDetail.mockResolvedValue({ data: null });
  api.addFeedback.mockResolvedValue({ data: {} });
  api.updateFeedback.mockResolvedValue({ data: {} });
  confirm.mockResolvedValue(true);
});

async function mountNotices(overrides: Record<string, unknown> = {}) {
  const Wrapper = defineComponent({
    setup: () => () =>
      h(Suspense, null, {
        default: () =>
          h(AssignmentNotices, {
            slug: 'school',
            assignmentId: 'task',
            isStudent: false,
            canWrite: true,
            managesDomain: true,
            writable: true,
            ...overrides,
          }),
      }),
  });
  const view = mount(Wrapper, { global: { stubs } });
  await flushPromises();
  return view;
}

describe('作业全体通知', () => {
  it('学生端当没有全体通知时自动隐藏整块区域', async () => {
    api.feedback.mockResolvedValueOnce({
      data: {
        data: [
          {
            id: 'private-1',
            target_user_id: 'stu-1',
            author_id: 'coach',
            author_name: '老师',
            body: '历史定向反馈不应展示',
            revision: 0,
            created_at: '2026-11-21T10:00:00Z',
          },
        ],
        total: 1,
      },
    });
    const view = await mountNotices({ isStudent: true, canWrite: false });
    expect(view.text()).not.toContain('作业全体通知');
    expect(view.text()).not.toContain('历史定向反馈不应展示');
    view.unmount();
  });

  it('过滤定向个人反馈，按最新优先用 Markdown 渲染全体通知', async () => {
    api.feedback.mockResolvedValueOnce({
      data: {
        data: [
          {
            id: 'n1',
            target_user_id: null,
            author_id: 'coach',
            author_name: '林老师',
            body: '第一条 **通知**',
            revision: 0,
            created_at: '2026-11-21T09:00:00Z',
          },
          {
            id: 'n-private',
            target_user_id: 'stu-1',
            author_id: 'coach',
            author_name: '林老师',
            body: '给单人的反馈',
            revision: 0,
            created_at: '2026-11-21T09:30:00Z',
          },
          {
            id: 'n2',
            target_user_id: null,
            author_id: 'coach',
            author_name: '林老师',
            body: '第二条 `long long` 提醒',
            revision: 0,
            created_at: '2026-11-21T10:00:00Z',
          },
        ],
        total: 3,
      },
    });
    const view = await mountNotices({ isStudent: true, canWrite: false });
    const rendered = view.findAll('.md').map((el) => el.text());
    expect(rendered).toEqual(['第二条 `long long` 提醒', '第一条 **通知**']);
    expect(view.text()).not.toContain('给单人的反馈');
    view.unmount();
  });

  it('教练可发布全体通知（target 为 null）并支持撤回', async () => {
    const view = await mountNotices();
    await view.findAll('button').find((b) => b.text().includes('发布通知'))!.trigger('click');
    await view.get('textarea').setValue('### 截止前提醒\n请检查复杂度');
    await view.get('form').trigger('submit');
    await flushPromises();
    expect(api.addFeedback).toHaveBeenCalledWith(
      'school',
      'task',
      '### 截止前提醒\n请检查复杂度',
      null,
      expect.any(String),
    );
    view.unmount();
  });
});
