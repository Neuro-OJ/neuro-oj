import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, ref, watch } from 'vue';
import ProblemHeader from '~/components/problem/ProblemHeader.vue';
import ProblemMetaCard from '~/components/problem/ProblemMetaCard.vue';
import KnowledgeNextLink from '~/components/knowledge/KnowledgeNextLink.vue';
import KnowledgeTags from '~/components/knowledge/KnowledgeTags.vue';
import type { ProblemView } from '~/utils/problemView';

const problem = {
  title: '数组求和',
  display_id: 'main:1002',
  difficulty: 'hard',
  tags: [],
  is_objective: false,
  judge_backend: 'isolate',
} as unknown as ProblemView;

const stubs = {
  NuxtLink: { props: ['to'], template: '<a :data-to="to"><slot /></a>' },
  UBadge: { template: '<span class="badge"><slot /></span>' },
  UIcon: true,
  DifficultyBadge: { props: ['difficulty'], template: '<span class="tier">{{ difficulty }}</span>' },
  UserIdentity: true,
};

const nextItem = {
  problem_id: 'p3',
  number: 1003,
  title: '数组旋转',
  domain: 'school',
  difficulty: 80,
  tier: 'hard',
  sample_size: 2,
  passed: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  for (const [name, value] of Object.entries({ computed, ref, watch })) vi.stubGlobal(name, value);
});

describe('难度标签（校准难度优先）', () => {
  it('有校准档位时覆盖出题人自报难度', () => {
    const wrapper = mount(ProblemHeader, { props: { problem, calibratedTier: 'medium' }, global: { stubs } });
    expect(wrapper.find('.tier').text()).toBe('medium');
  });

  it('无校准时保持原有难度显示', () => {
    const wrapper = mount(ProblemHeader, { props: { problem }, global: { stubs } });
    expect(wrapper.find('.tier').text()).toBe('hard');
  });

  it('右栏信息卡同样优先显示校准难度', () => {
    const wrapper = mount(ProblemMetaCard, { props: { problem, calibratedTier: 'easy' }, global: { stubs } });
    expect(wrapper.find('.tier').text()).toBe('easy');
    expect(wrapper.text()).toContain('校准');
  });
});

describe('题目页知识点标签', () => {
  const view = {
    problem_id: 'p2',
    state: 'classified' as const,
    primary: {
      node_id: 'ds.array',
      name: '数组',
      role: 'primary' as const,
      source: 'human' as const,
      confidence: null,
      review_status: 'confirmed' as const,
      version_id: null,
      updated_at: '',
    },
    secondary: [{
      node_id: 'ds.list',
      name: '链表',
      role: 'secondary' as const,
      source: 'human' as const,
      confidence: null,
      review_status: 'confirmed' as const,
      version_id: null,
      updated_at: '',
    }],
    pending: false,
  };

  it('传入域时标签链到知识点页', () => {
    const wrapper = mount(KnowledgeTags, { props: { view, domain: 'school' }, global: { stubs } });
    const hrefs = wrapper.findAll('a').map((link) => link.attributes('data-to'));
    expect(hrefs).toEqual(['/d/school/knowledge/ds.array', '/d/school/knowledge/ds.list']);
  });

  it('未传域时仅只读展示', () => {
    const wrapper = mount(KnowledgeTags, { props: { view }, global: { stubs } });
    expect(wrapper.findAll('a')).toHaveLength(0);
    expect(wrapper.text()).toContain('数组');
  });
});

describe('同类下一题', () => {
  function mountNext(loadNextForProblem: ReturnType<typeof vi.fn>, disabled = ref(false)) {
    vi.stubGlobal('useKnowledge', () => ({ disabled, loadNextForProblem }));
    return mount(KnowledgeNextLink, { props: { problemId: 'p2' }, global: { stubs } });
  }

  it('有下一题时显示入口并链接到该题', async () => {
    const load = vi.fn(() => Promise.resolve(nextItem));
    const wrapper = mountNext(load);
    await flushPromises();
    expect(load).toHaveBeenCalledWith('p2');
    expect(wrapper.text()).toContain('同类下一题');
    expect(wrapper.text()).toContain('数组旋转');
    expect(wrapper.find('a').attributes('data-to')).toBe('/d/school/problems/1003');
    expect(wrapper.find('.tier').text()).toBe('hard');
  });

  it('无下一题时不渲染', async () => {
    const wrapper = mountNext(vi.fn(() => Promise.resolve(null)));
    await flushPromises();
    expect(wrapper.text()).toBe('');
  });

  it('功能关闭时不渲染', async () => {
    const load = vi.fn(() => Promise.resolve(nextItem));
    const wrapper = mountNext(load, ref(true));
    await flushPromises();
    expect(wrapper.text()).toBe('');
    expect(load).not.toHaveBeenCalled();
  });

  it('未归类（组件层返回 null）时不渲染', () => {
    const wrapper = mount(
      defineComponent({ setup: () => () => h(KnowledgeNextLink, { problemId: null }) }),
      { global: { stubs } },
    );
    expect(wrapper.text()).toBe('');
  });
});
