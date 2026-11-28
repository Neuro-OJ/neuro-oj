import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { computed, ref, watch } from 'vue';
import KnowledgeSkillTree from '~/components/knowledge/KnowledgeSkillTree.vue';
import type { KnowledgeGraph, MasteryItem } from '~/utils/domain/education/knowledge';

const graph: KnowledgeGraph = {
  pack: { id: 'official', version: '2026.11.0-draft' },
  areas: [
    { id: 'ai', name: '人工智能基础', sort: 0 },
    { id: 'ml', name: '经典机器学习', sort: 1 },
  ],
  nodes: [
    {
      id: 'ai.concepts',
      area: 'ai',
      name: '人工智能基本概念',
      summary: '关系与脉络',
      syllabus: ['noai', 'lmcc'],
      doc: 'docs/ai.concepts.md',
      requires: [],
      problem_count: 2,
    },
    {
      id: 'ml.linear',
      area: 'ml',
      name: '线性回归',
      summary: '梯度下降',
      syllabus: ['ioai', 'noai'],
      doc: null,
      requires: ['ai.concepts'],
      problem_count: 3,
    },
  ],
};

const masteryItems: MasteryItem[] = [
  {
    node_id: 'ai.concepts',
    name: '人工智能基本概念',
    area: 'ai',
    state: 'mastered',
    solved_count: 3,
    attempted_count: 3,
    failed_attempts: 0,
    max_passed_difficulty: 50,
    ability_score: 78,
    effective_ability: 64,
    needs_review: true,
    problem_count: 2,
  },
];

beforeEach(() => {
  for (const [name, value] of Object.entries({ computed, ref, watch })) vi.stubGlobal(name, value);
});

describe('KnowledgeSkillTree', () => {
  it('展示领域标签、拓扑节点卡片与讲解/题数标记，并支持切换领域', async () => {
    const wrapper = mount(KnowledgeSkillTree, {
      props: {
        graph,
        slug: 'school',
        masteryItems,
        recommendations: [],
        placedNodeIds: [],
      },
      global: {
        stubs: {
          NuxtLink: { props: ['to'], template: '<a :data-to="to"><slot /></a>' },
          UButton: {
            props: ['type', 'color', 'variant', 'size', 'block', 'icon'],
            template: '<button :type="type || \'button\'"><slot /></button>',
          },
          UInput: {
            props: ['modelValue', 'type', 'placeholder'],
            emits: ['update:modelValue', 'focus', 'blur'],
            template:
              '<input :type="type || \'text\'" :value="modelValue" :placeholder="placeholder" @input="$emit(\'update:modelValue\', ($event.target).value)" @focus="$emit(\'focus\', $event)" @blur="$emit(\'blur\', $event)" />',
          },
        },
      },
    });

    expect(wrapper.find('[data-testid="knowledge-global-overview"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="overview-area-card-ai"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="overview-area-card-ml"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="skill-area-tab-ai"]').text()).toContain('1/1');
    const aiNode = wrapper.find('[data-testid="skill-node-ai.concepts"]');
    expect(aiNode.exists()).toBe(true);
    expect(aiNode.text()).toContain('已掌握');
    expect(aiNode.text()).toContain('待复习');
    expect(aiNode.text()).toContain('能力 64');
    expect(aiNode.text()).toContain('讲解');
    expect(aiNode.text()).toContain('题 2');
    const docLink = wrapper.find('[data-testid="skill-node-doc-ai.concepts"]');
    expect(docLink.exists()).toBe(true);
    expect(docLink.attributes('data-to')).toBe('/d/school/knowledge/ai.concepts');

    // 点击节点打开总览快览面板
    await aiNode.trigger('click');
    const inspector = wrapper.find('[data-testid="overview-node-inspector"]');
    expect(inspector.exists()).toBe(true);
    expect(inspector.text()).toContain('人工智能基本概念');
    expect(inspector.text()).toContain('后继 1');

    // 切换至单领域视图
    await wrapper.find('[data-testid="skill-area-tab-ml"]').trigger('click');
    const mlNode = wrapper.find('[data-testid="skill-node-ml.linear"]');
    expect(mlNode.exists()).toBe(true);
    expect(mlNode.text()).toContain('已解锁');
    expect(mlNode.text()).toContain('前置域 1/1');

    // 从单领域视图通过搜索定位节点：切回全图总览后应保留选中节点与聚焦领域，不被挂载 fit 覆盖
    const searchInput = wrapper.find('[data-testid="overview-search-input"]');
    await searchInput.trigger('focus');
    await searchInput.setValue('线性回归');
    const firstHit = wrapper.find('[data-testid="overview-search-results"] button');
    expect(firstHit.exists()).toBe(true);
    await firstHit.trigger('mousedown');
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="knowledge-global-overview"]').exists()).toBe(true);
    const focusedInspector = wrapper.find('[data-testid="overview-node-inspector"]');
    expect(focusedInspector.exists()).toBe(true);
    expect(focusedInspector.text()).toContain('线性回归');

    // 切回全图总览（适配全部）
    await wrapper.find('[data-testid="skill-area-tab-overview"]').trigger('click');
    expect(wrapper.find('[data-testid="knowledge-global-overview"]').exists()).toBe(true);
  });
});
