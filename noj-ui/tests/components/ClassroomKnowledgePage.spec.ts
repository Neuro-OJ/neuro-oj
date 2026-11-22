import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, reactive, ref, Suspense, watch } from 'vue';
import ClassroomKnowledgePage from '~/pages/d/[slug]/classrooms/[classroomId]/knowledge.vue';

const disabled = ref(false);
const manages = ref(true);
const loadClassroomMastery = vi.fn();

const stubs = {
  NuxtLink: { props: ['to'], template: '<a :data-to="to"><slot /></a>' },
  UBadge: { template: '<span><slot /></span>' },
  UAlert: { props: ['title'], template: '<p class="alert">{{ title }}</p>' },
  UCheckbox: {
    props: ['modelValue', 'label'],
    emits: ['update:modelValue'],
    template:
      '<label>{{ label }}<input type="checkbox" :checked="modelValue" @change="$emit(\'update:modelValue\', $event.target.checked)" /></label>',
  },
  UIcon: true,
  ClassroomNavigation: { props: ['slug', 'classroomId'], template: '<nav class="classroom-nav" />' },
  LibraryPageHeader: { props: ['title'], template: '<h1>{{ title }}</h1>' },
};

function mountPage() {
  // 页面使用顶层 await（useAsyncData），需要 Suspense 包裹。
  const Wrapper = defineComponent({
    setup: () => () => h(Suspense, null, { default: () => h(ClassroomKnowledgePage) }),
  });
  return mount(Wrapper, { global: { stubs } });
}

function view() {
  return {
    classroom_id: 'class',
    students: [
      { user_id: 'u1', username: 'student-a', display_name: '学生甲' },
      { user_id: 'u2', username: 'student-b', display_name: null },
    ],
    areas: [
      {
        id: 'ml',
        name: '机器学习基础',
        nodes: [
          { id: 'ml.lr', name: '线性回归', problem_count: 4, counts: { mastered: 1, learning: 1, none: 0 } },
          { id: 'ml.svm', name: '支持向量机', problem_count: 2, counts: { mastered: 0, learning: 0, none: 2 } },
        ],
      },
      {
        id: 'algo',
        name: '算法',
        nodes: [{ id: 'algo.dp', name: '动态规划', problem_count: 5, counts: { mastered: 0, learning: 1, none: 1 } }],
      },
    ],
    cells: { u1: { 'ml.lr': 'mastered', 'algo.dp': 'learning' }, u2: { 'ml.lr': 'learning' } },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  disabled.value = false;
  manages.value = true;
  for (const [name, value] of Object.entries({ computed, ref, watch })) vi.stubGlobal(name, value);
  vi.stubGlobal('definePageMeta', vi.fn());
  vi.stubGlobal('useSeoMeta', vi.fn());
  vi.stubGlobal('useBreadcrumbParams', vi.fn());
  vi.stubGlobal('useRoute', () => ({ params: { classroomId: 'class', slug: 'school' } }));
  vi.stubGlobal('useWorkspace', () => ({ slug: ref('school'), domain: reactive({ status: 'active' }) }));
  vi.stubGlobal('useState', () => ref({ id: 'teacher' }));
  vi.stubGlobal('useEducationApi', () => ({
    classroom: vi.fn(() => Promise.resolve({ data: { id: 'class', name: '一班', manages_domain: manages.value } })),
  }));
  vi.stubGlobal('useAsyncData', async (_key: unknown, load: () => Promise<unknown>) => ({
    data: ref(await load()),
    error: ref(null),
    status: ref('success'),
    refresh: vi.fn(),
  }));
  vi.stubGlobal('useKnowledge', () => ({ disabled, loadClassroomMastery }));
  loadClassroomMastery.mockResolvedValue(view());
});

describe('班级知识点掌握矩阵', () => {
  it('渲染色块与列统计，默认只展开第一个领域', async () => {
    const page = mountPage();
    await flushPromises();
    // 默认只展开第一个领域：2 名学生 × 2 个节点 = 4 个单元格。
    const cells = page.findAll('[data-testid="mastery-cell"]');
    expect(cells).toHaveLength(4);
    expect(cells.map((cell) => cell.attributes('data-state'))).toEqual(['mastered', 'none', 'learning', 'none']);
    expect(cells[0]!.attributes('title')).toBe('学生甲 · 线性回归：已掌握');
    expect(page.get('[data-testid="mastery-counts-ml.lr"]').text()).toBe('已掌握 1 / 学习中 1');
    expect(page.get('[data-testid="mastery-counts-ml.lr"]').classes()).toContain('tabular-nums');
    // 第二个领域默认折叠
    expect(page.find('[data-testid="mastery-counts-algo.dp"]').exists()).toBe(false);
    // 表头节点链到知识点页
    const link = page.findAll('a').find((a) => a.text() === '线性回归')!;
    expect(link.attributes('data-to')).toBe('/d/school/knowledge/ml.lr');
    page.unmount();
  });

  it('只看有学生在学的知识点：过滤掉无人学习的节点', async () => {
    const page = mountPage();
    await flushPromises();
    const box = page.find('[data-testid="only-learning"] input');
    expect(box.exists()).toBe(true);
    await box.setValue(true);
    await flushPromises();
    const cells = page.findAll('[data-testid="mastery-cell"]');
    expect(cells).toHaveLength(2);
    expect(page.find('[data-testid="mastery-counts-ml.svm"]').exists()).toBe(false);
    page.unmount();
  });

  it('无学生或无节点时显示空态', async () => {
    loadClassroomMastery.mockResolvedValue({ ...view(), students: [] });
    let page = mountPage();
    await flushPromises();
    expect(page.find('[data-testid="knowledge-empty-students"]').exists()).toBe(true);
    page.unmount();

    loadClassroomMastery.mockResolvedValue({ ...view(), areas: [] });
    page = mountPage();
    await flushPromises();
    expect(page.find('[data-testid="knowledge-empty-nodes"]').exists()).toBe(true);
    page.unmount();
  });

  it('总开关关闭时只显示未开启提示，不发请求', async () => {
    disabled.value = true;
    const page = mountPage();
    await flushPromises();
    expect(page.get('[data-testid="knowledge-disabled"]').text()).toBe('本实例未开启知识图谱。');
    expect(page.find('[data-testid="mastery-matrix"]').exists()).toBe(false);
    page.unmount();
  });

  it('非教练只显示无权限提示，不请求矩阵', async () => {
    manages.value = false;
    const page = mountPage();
    await flushPromises();
    expect(page.find('[data-testid="knowledge-forbidden"]').exists()).toBe(true);
    expect(loadClassroomMastery).not.toHaveBeenCalled();
    page.unmount();
  });
});
