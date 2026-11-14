import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, ref, watch } from 'vue';
import KnowledgeNodePage from '~/pages/d/[slug]/knowledge/[nodeId].vue';

const disabled = ref(false);
const node = ref<Record<string, unknown> | null>(null);
const ladder = ref<Record<string, unknown> | null>(null);
const loadNode = vi.fn(() => Promise.resolve(node.value));
const loadLadder = vi.fn(() => Promise.resolve(ladder.value));
const loadGraph = vi.fn(() =>
  Promise.resolve({
    pack: { id: 'official', version: '1' },
    areas: [{ id: 'ds', name: '数据结构', sort: 1 }],
    nodes: [
      { id: 'ds.array', area: 'ds', name: '数组', summary: null, requires: [] },
      { id: 'ds.list', area: 'ds', name: '链表', summary: null, requires: [] },
      { id: 'ds.stack', area: 'ds', name: '栈', summary: null, requires: [] },
    ],
  })
);

const stubs = {
  NuxtLink: { props: ['to'], template: '<a :data-to="to"><slot /></a>' },
  UBadge: { template: '<span class="badge"><slot /></span>' },
  UButton: { props: ['to', 'label'], template: '<a class="btn" :data-to="to">{{ label }}</a>' },
  UAlert: { props: ['title'], template: '<p class="alert">{{ title }}</p>' },
  AsyncContent: { template: '<div><slot /></div>' },
  MarkdownRenderer: { props: ['content'], template: '<div class="md">{{ content }}</div>' },
  DifficultyBadge: { props: ['difficulty'], template: '<span class="tier">{{ difficulty }}</span>' },
  UIcon: true,
  KnowledgeTags: true,
};

function mountPage() {
  return mount(KnowledgeNodePage, { global: { stubs } });
}

beforeEach(() => {
  vi.clearAllMocks();
  disabled.value = false;
  for (const [name, value] of Object.entries({ computed, ref, watch })) vi.stubGlobal(name, value);
  vi.stubGlobal('definePageMeta', vi.fn());
  vi.stubGlobal('useSeoMeta', vi.fn());
  vi.stubGlobal(
    'useRoute',
    () => ({ params: { nodeId: 'ds.array' }, query: {}, path: '/d/school/knowledge/ds.array' }),
  );
  vi.stubGlobal('useWorkspace', () => ({ slug: ref('school') }));
  vi.stubGlobal('useAuth', () => ({ user: ref({ id: 'student' }) }));
  vi.stubGlobal('useKnowledge', () => ({
    disabled,
    graph: ref(null),
    loadNode,
    loadLadder,
    loadGraph,
    loadProblem: () => Promise.resolve(null),
    loadNextForProblem: () => Promise.resolve(null),
    saveProblem: vi.fn(),
  }));
  node.value = {
    id: 'ds.array',
    area: 'ds',
    name: '数组',
    summary: '连续存储的线性表',
    syllabus: ['线性表'],
    doc: null,
    requires: [],
    dependents: ['ds.list'],
  };
  ladder.value = { node_id: 'ds.array', domain: 'school', items: [], next: null };
});

describe('知识点页', () => {
  it('渲染标题、领域、考纲标签、后续知识点链接；无讲解时不显示讲解区块与首题按钮', async () => {
    const wrapper = mountPage();
    await flushPromises();
    expect(loadNode).toHaveBeenCalledWith('ds.array');
    expect(loadLadder).toHaveBeenCalledWith('ds.array', 'school');
    const text = wrapper.text();
    expect(text).toContain('数组');
    expect(text).toContain('数据结构');
    expect(text).toContain('线性表');
    expect(text).toContain('后续知识点');
    expect(text).not.toContain('讲解');
    expect(wrapper.find('.btn').exists()).toBe(false);
    expect(wrapper.find('a[data-to="/d/school/knowledge/ds.list"]').exists()).toBe(true);
  });

  it('有讲解时渲染 markdown 并给出「去做第一题」跳到阶梯首题', async () => {
    node.value = { ...node.value!, doc: '## 讲解\n数组下标从 0 开始', requires: ['ds.stack'] };
    ladder.value = {
      node_id: 'ds.array',
      domain: 'school',
      items: [
        {
          problem_id: 'p1',
          number: 1001,
          title: '访问数组',
          domain: 'school',
          difficulty: 20,
          tier: 'easy',
          sample_size: 3,
          passed: true,
        },
      ],
      next: {
        problem_id: 'p1',
        number: 1001,
        title: '访问数组',
        domain: 'school',
        difficulty: 20,
        tier: 'easy',
        sample_size: 3,
        passed: true,
      },
    };
    const wrapper = mountPage();
    await flushPromises();
    expect(wrapper.find('.md').text()).toContain('数组下标从 0 开始');
    expect(wrapper.text()).toContain('前置知识点');
    expect(wrapper.find('a.btn[data-to="/d/school/problems/1001"]').text()).toBe('去做第一题');
  });

  it('空阶梯显示「本空间暂无该知识点的题目」', async () => {
    const wrapper = mountPage();
    await flushPromises();
    expect(wrapper.text()).toContain('本空间暂无该知识点的题目');
    expect(wrapper.text()).toContain('共 0 题');
  });

  it('按难度升序展示阶梯，高亮 next 并标记已达标', async () => {
    ladder.value = {
      node_id: 'ds.array',
      domain: 'school',
      items: [
        {
          problem_id: 'p1',
          number: 1001,
          title: '访问数组',
          domain: 'school',
          difficulty: 20,
          tier: 'easy',
          sample_size: 3,
          passed: true,
        },
        {
          problem_id: 'p2',
          number: 1002,
          title: '数组求和',
          domain: 'school',
          difficulty: 55,
          tier: 'medium',
          sample_size: 0,
          passed: false,
        },
        {
          problem_id: 'p3',
          number: 1003,
          title: '数组旋转',
          domain: 'school',
          difficulty: 80,
          tier: 'hard',
          sample_size: 1,
          passed: false,
        },
      ],
      next: {
        problem_id: 'p2',
        number: 1002,
        title: '数组求和',
        domain: 'school',
        difficulty: 55,
        tier: 'medium',
        sample_size: 0,
        passed: false,
      },
    };
    const wrapper = mountPage();
    await flushPromises();
    const rows = wrapper.findAll('ol > li');
    expect(rows.map((row) => row.text().match(/100\d/)?.[0])).toEqual(['1001', '1002', '1003']);
    expect(rows[0]!.text()).toContain('已达标');
    expect(rows[1]!.text()).toContain('推荐下一题');
    expect(rows[2]!.text()).not.toContain('推荐下一题');
    // 难度档位徽章走 DifficultyBadge（配色由设计 token 决定）
    expect(rows.map((row) => row.find('.tier').text())).toEqual(['easy', 'medium', 'hard']);
  });

  it('KNOWLEDGE_DISABLED 时整块隐藏且不报错', async () => {
    disabled.value = true;
    const wrapper = mountPage();
    await flushPromises();
    expect(wrapper.text()).toBe('');
    expect(wrapper.find('.alert').exists()).toBe(false);
  });

  it('节点不存在时提示而不渲染阶梯', async () => {
    node.value = null;
    const wrapper = mountPage();
    await flushPromises();
    expect(wrapper.text()).toContain('知识点不存在或已被移除');
  });
});
