import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, ref, watch } from 'vue';
import KnowledgeIndexPage from '~/pages/d/[slug]/knowledge/index.vue';

const disabled = ref(false);
const loggedIn = ref(true);
const mastery = ref<Record<string, unknown> | null>(null);
const recommendationView = ref<Record<string, unknown> | null>(null);
const loadMyMastery = vi.fn((_domain?: string) => Promise.resolve(mastery.value));
const loadRecommendations = vi.fn((_domain: string, _limit?: number) => Promise.resolve(recommendationView.value));

const stubs = {
  NuxtLink: { props: ['to'], template: '<a :data-to="to"><slot /></a>' },
  UBadge: { template: '<span class="badge"><slot /></span>' },
  UAlert: { props: ['title', 'description'], template: '<p class="alert">{{ title }}{{ description }}</p>' },
  UButton: { props: ['to', 'label'], template: '<a class="btn" :data-to="to">{{ label }}</a>' },
  AsyncContent: {
    props: ['status', 'error'],
    template: '<div class="async"><slot v-if="status !== \'loading\'" /><p v-else class="loading" /></div>',
  },
  DifficultyBadge: { props: ['difficulty'], template: '<span class="tier">{{ difficulty }}</span>' },
  UIcon: true,
};

function mountPage() {
  return mount(KnowledgeIndexPage, { global: { stubs } });
}

function recommend(code: string, params: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    node: { id: 'ds.array', name: '数组', area: 'ds', state: 'learning', problem_count: 3 },
    reason: { code, params },
    next: {
      problem_id: 'p1',
      number: 1001,
      title: '访问数组',
      domain: 'school',
      difficulty: 20,
      tier: 'easy',
      sample_size: 3,
      passed: false,
    },
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  disabled.value = false;
  loggedIn.value = true;
  for (const [name, value] of Object.entries({ computed, ref, watch })) vi.stubGlobal(name, value);
  vi.stubGlobal('definePageMeta', vi.fn());
  vi.stubGlobal('useSeoMeta', vi.fn());
  vi.stubGlobal('useBreadcrumbParams', vi.fn());
  vi.stubGlobal('useWorkspace', () => ({ slug: ref('school') }));
  vi.stubGlobal('useAuth', () => ({ isLoggedIn: loggedIn, user: ref(loggedIn.value ? { id: 'u1' } : null) }));
  vi.stubGlobal('useKnowledge', () => ({
    disabled,
    loadMyMastery,
    loadRecommendations,
  }));
  mastery.value = {
    domain: { id: 'd1', slug: 'school' },
    mastered: 1,
    learning: 1,
    total: 2,
    items: [
      {
        node_id: 'ds.array',
        name: '数组',
        area: 'ds',
        state: 'mastered',
        solved_count: 3,
        attempted_count: 3,
        failed_attempts: 0,
        max_passed_difficulty: 40,
        problem_count: 3,
      },
      {
        node_id: 'ds.list',
        name: '链表',
        area: 'ds',
        state: 'learning',
        solved_count: 1,
        attempted_count: 2,
        failed_attempts: 1,
        max_passed_difficulty: 30,
        problem_count: 2,
      },
    ],
  };
  recommendationView.value = { domain: { id: 'd1', slug: 'school' }, items: [] };
});

describe('我的学习页', () => {
  it('四种推荐理由按 code 拼中文，并链到知识点页与推荐题', async () => {
    recommendationView.value = {
      domain: { id: 'd1', slug: 'school' },
      items: [
        recommend('continue_learning', { node_id: 'ds.array', node_name: '数组', remaining: 2 }),
        recommend('prerequisites_mastered', {
          node_id: 'ds.array',
          prerequisites: [{ id: 'ds.stack', name: '栈' }, { id: 'ds.queue', name: '队列' }],
        }),
        recommend('entry_point', { node_id: 'ds.auto', node_name: '自动机' }),
        recommend('review_prerequisite', {
          node_id: 'ds.tree',
          node_name: '树',
          prerequisite_id: 'ds.list',
          prerequisite_name: '链表',
        }, {
          node: { id: 'ds.list', name: '链表', area: 'ds', state: 'learning', problem_count: 2 },
        }),
      ],
    };
    const wrapper = mountPage();
    await flushPromises();
    const text = wrapper.text();
    expect(text).toContain('已在学习中，再完成 2 道达标题即可掌握');
    expect(text).toContain('前置知识点 栈、队列 已掌握，可以开始');
    expect(text).toContain('入门知识点，适合作为起点');
    expect(text).toContain('你在 树 上多次未达标，建议先巩固 链表');
    expect(wrapper.findAll('[data-testid="recommendation-card"]')).toHaveLength(4);
    expect(wrapper.find('a[data-to="/d/school/knowledge/ds.array"]').exists()).toBe(true);
    expect(wrapper.find('a[data-to="/d/school/problems/1001"]').exists()).toBe(true);
  });

  it('未知 reason code 回退通用文案', async () => {
    recommendationView.value = {
      domain: { id: 'd1', slug: 'school' },
      items: [recommend('brand_new_reason', {})],
    };
    const wrapper = mountPage();
    await flushPromises();
    expect(wrapper.text()).toContain('根据你的学习进度推荐');
  });

  it('无推荐时显示空态', async () => {
    const wrapper = mountPage();
    await flushPromises();
    expect(wrapper.text()).toContain('暂无推荐，去题库做几道题吧');
  });

  it('领域汇总显示已掌握/学习中/总数与节点状态徽标', async () => {
    const wrapper = mountPage();
    await flushPromises();
    expect(loadMyMastery).toHaveBeenCalledWith('school');
    expect(loadRecommendations).toHaveBeenCalledWith('school', 5);
    const summary = wrapper.find('[data-testid="mastery-summary"]');
    expect(summary.exists()).toBe(true);
    const text = summary.text();
    expect(text).toContain('已掌握');
    expect(text).toContain('学习中');
    expect(text).toContain('总数');
    expect(text).toContain('1');
    expect(text).toContain('2');
    expect(text).toContain('掌握率 50%');
    const nodes = wrapper.findAll('[data-testid="mastery-node"]');
    expect(nodes).toHaveLength(2);
    expect(nodes[0]!.text()).toContain('已掌握');
    expect(nodes[1]!.text()).toContain('学习中');
    expect(wrapper.find('a[data-to="/d/school/knowledge/ds.list"]').exists()).toBe(true);
  });

  it('KNOWLEDGE_DISABLED（总开关关闭）只显示未开启提示且不报错', async () => {
    disabled.value = true;
    const wrapper = mountPage();
    await flushPromises();
    expect(wrapper.text()).toBe('本实例未开启知识图谱。');
    expect(wrapper.find('.alert').exists()).toBe(false);
  });

  it('未登录提示登录且不请求个人数据', async () => {
    loggedIn.value = false;
    const wrapper = mountPage();
    await flushPromises();
    expect(wrapper.text()).toContain('登录后查看你的学习进度');
    expect(loadMyMastery).not.toHaveBeenCalled();
    expect(loadRecommendations).not.toHaveBeenCalled();
  });
});
