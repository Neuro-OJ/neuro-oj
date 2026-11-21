import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h, ref, Suspense } from 'vue';
import AssignmentHelpList from '~/components/education/AssignmentHelpList.vue';

const api = {
  help: vi.fn(),
  ask: vi.fn(),
};
const mockNavigateTo = vi.fn();

const stubs = {
  UAlert: { props: ['title'], template: '<p role="alert">{{ title }}</p>' },
  UBadge: { template: '<span class="badge"><slot /></span>' },
  UIcon: {
    props: ['name', 'ariaLabel'],
    template: '<i :data-icon="name" :aria-label="ariaLabel" />',
  },
  USelect: { template: '<select />' },
  NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
  UButton: {
    props: ['type', 'disabled'],
    template: '<button :type="type || \'button\'" :disabled="disabled"><slot /></button>',
  },
  MarkdownRenderer: { props: ['content'], template: '<div class="md">{{ content }}</div>' },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('useUnsavedChanges', vi.fn());
  vi.stubGlobal('navigateTo', mockNavigateTo);
  vi.stubGlobal('useState', () => ref({ id: 'coach' }));
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
  api.help.mockResolvedValue({
    data: {
      data: [
        {
          id: 'h-pending',
          user_id: 'stu-1',
          author_name: 'stu_wang',
          item_id: 'item-1',
          body: '# 第三个测试点 RE\n详细堆栈如下',
          state: 'open',
          answered_by_coach: false,
          reply_count: 0,
          revision: 0,
          updated_at: '2026-11-21T10:00:00Z',
        },
        {
          id: 'h-answered',
          user_id: 'stu-2',
          author_name: 'stu_01',
          item_id: null,
          body: '`Fuel` 限制问题',
          state: 'open',
          answered_by_coach: true,
          reply_count: 2,
          revision: 1,
          updated_at: '2026-11-21T09:30:00Z',
        },
        {
          id: 'h-resolved',
          user_id: 'stu-3',
          author_name: 'stu_chen',
          item_id: 'item-1',
          body: '格式分问题已理解',
          state: 'resolved',
          answered_by_coach: true,
          reply_count: 3,
          revision: 2,
          updated_at: '2026-11-21T09:00:00Z',
        },
      ],
      total: 3,
    },
  });
  api.ask.mockResolvedValue({ data: { id: 'h-created' } });
});

async function mountHelpList(overrides: Record<string, unknown> = {}) {
  const Wrapper = defineComponent({
    setup: () => () =>
      h(Suspense, null, {
        default: () =>
          h(AssignmentHelpList, {
            slug: 'school',
            assignmentId: 'task',
            isStudent: false,
            canHelp: true,
            writable: true,
            items: [{ id: 'item-1', displayRef: '1001', title: 'A+B Problem' }],
            ...overrides,
          }),
      }),
  });
  const view = mount(Wrapper, { global: { stubs } });
  await flushPromises();
  return view;
}

describe('Issue 风格学生求助列表', () => {
  it('使用不同状态图标清晰区分待回答、教练已回答和已处理，并提供详情直达链接', async () => {
    const view = await mountHelpList();
    expect(view.text()).toContain('第三个测试点 RE');
    expect(view.text()).toContain('Fuel 限制问题');
    expect(view.text()).toContain('格式分问题已理解');
    expect(view.find('i[aria-label="待回答"]').exists()).toBe(true);
    expect(view.find('i[aria-label="教练已回答"]').exists()).toBe(true);
    expect(view.find('i[aria-label="已处理"]').exists()).toBe(true);
    expect(view.find('a[href="/d/school/assignments/task/help/h-pending"]').exists()).toBe(true);
    expect(view.find('a[href="/d/school/assignments/task/help/h-answered"]').exists()).toBe(true);
    expect(view.find('[aria-label="2 条回复"]').exists()).toBe(true);
    view.unmount();
  });

  it('学生提交新求助后直接跳转新创建的 Issue 详情页', async () => {
    const view = await mountHelpList({ isStudent: true, canHelp: false });
    await view.findAll('button').find((b) => b.text().includes('发起求助'))!.trigger('click');
    await view.get('textarea').setValue('为什么 RE 了？\n```py\n1/0\n```');
    await view.get('form').trigger('submit');
    await flushPromises();
    expect(api.ask).toHaveBeenCalledWith(
      'school',
      'task',
      '为什么 RE 了？\n```py\n1/0\n```',
      expect.any(String),
      null,
    );
    expect(mockNavigateTo).toHaveBeenCalledWith('/d/school/assignments/task/help/h-created');
    view.unmount();
  });
});
