import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h, ref, Suspense } from 'vue';
import HelpDetailPage from '~/pages/d/[slug]/assignments/[assignmentId]/help/[helpId].vue';

const api = {
  assignment: vi.fn(),
  classroom: vi.fn(),
  helpDetail: vi.fn(),
  reply: vi.fn(),
  setHelpState: vi.fn(),
};

const stubs = {
  AsyncContent: { props: ['status'], template: '<div><slot /></div>' },
  UAlert: { props: ['title'], template: '<p role="alert">{{ title }}</p>' },
  UBadge: { template: '<span class="badge"><slot /></span>' },
  UIcon: true,
  NuxtLink: { props: ['to'], template: '<a :href="typeof to === \'string\' ? to : to.path"><slot /></a>' },
  UButton: {
    props: ['type', 'disabled'],
    template: '<button :type="type || \'button\'" :disabled="disabled"><slot /></button>',
  },
  MarkdownRenderer: { props: ['content'], template: '<div class="md">{{ content }}</div>' },
};

beforeEach(() => {
  vi.clearAllMocks();
  for (const name of ['definePageMeta', 'useSeoMeta', 'useBreadcrumbParams', 'useUnsavedChanges']) {
    vi.stubGlobal(name, vi.fn());
  }
  vi.stubGlobal('useRoute', () => ({ params: { assignmentId: 'task', helpId: 'h-1' } }));
  vi.stubGlobal('useState', () => ref({ id: 'coach' }));
  vi.stubGlobal('useWorkspace', () => ({
    slug: ref('school'),
    domain: ref({ status: 'active', configuration: { features: { classroom: true, assignment: true } } }),
  }));
  vi.stubGlobal('useEducationApi', () => api);
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

  api.assignment.mockResolvedValue({
    data: {
      id: 'task',
      classroom_id: 'room-1',
      title: '第 1 周作业',
      state: 'published',
      items: [
        { id: 'item-1', reference: { display_ref: '1001', qualified_ref: 'school:1001' } },
      ],
    },
  });
  api.classroom.mockResolvedValue({
    data: { id: 'room-1', status: 'active', manages_domain: true, membership: null, capabilities: [] },
  });
  api.helpDetail.mockResolvedValue({
    data: {
      id: 'h-1',
      user_id: 'stu-1',
      author_name: 'stu_chen',
      item_id: 'item-1',
      body: '为什么输出格式被扣分\n详细代码示例 `strip()`',
      state: 'open',
      answered_by_coach: true,
      revision: 1,
      created_at: '2026-11-21T09:00:00Z',
      reply_total: 2,
      replies: [
        {
          id: 'r-1',
          author_id: 'coach',
          author_name: 'prof_lin',
          is_coach: true,
          body: '请先调用 `.strip()` 清理换行符',
          created_at: '2026-11-21T09:05:00Z',
        },
        {
          id: 'r-2',
          author_id: 'stu-1',
          author_name: 'stu_chen',
          is_coach: false,
          body: '收到，已经明白！',
          created_at: '2026-11-21T09:10:00Z',
        },
      ],
    },
  });
  api.reply.mockResolvedValue({ data: {} });
  api.setHelpState.mockResolvedValue({ data: { state: 'resolved', revision: 2 } });
});

async function mountDetail() {
  const Wrapper = defineComponent({
    setup: () => () => h(Suspense, null, { default: () => h(HelpDetailPage) }),
  });
  const view = mount(Wrapper, { global: { stubs } });
  await flushPromises();
  return view;
}

describe('求助 Issue 详情页（Comment Flow）', () => {
  it('渲染首楼正文与时间线回复，并正确标注教练与提问者身份', async () => {
    const view = await mountDetail();
    expect(view.find('h1').text()).toBe('为什么输出格式被扣分');
    expect(view.text()).toContain('教练已回答');
    expect(view.text()).toContain('prof_lin');
    expect(view.text()).toContain('stu_chen');
    const comments = view.findAll('.md').map((el) => el.text());
    expect(comments).toHaveLength(3);
    expect(comments[1]).toContain('请先调用 `.strip()` 清理换行符');
    expect(comments[2]).toBe('收到，已经明白！');
    expect(view.find('a[href="/d/school/assignments/task"]').exists()).toBe(true);
    view.unmount();
  });

  it('教练可一键「回复并标记已处理」', async () => {
    const view = await mountDetail();
    await view.get('textarea').setValue('已验证你的修复提交，满分通过！');
    await view.findAll('button').find((b) => b.text().includes('回复并标记已处理'))!.trigger('click');
    await flushPromises();
    expect(api.reply).toHaveBeenCalledWith(
      'school',
      'task',
      'h-1',
      '已验证你的修复提交，满分通过！',
      expect.any(String),
      true,
    );
    view.unmount();
  });

  it('教练可直接切换问题处理状态', async () => {
    const view = await mountDetail();
    await view.findAll('button').find((b) => b.text().includes('标记已处理'))!.trigger('click');
    await flushPromises();
    expect(api.setHelpState).toHaveBeenCalledWith('school', 'task', 'h-1', 1, 'resolved');
    view.unmount();
  });
});
