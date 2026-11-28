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
        },
      },
    });

    expect(wrapper.find('[data-testid="skill-area-tab-ai"]').text()).toContain('1/1');
    const aiNode = wrapper.find('[data-testid="skill-node-ai.concepts"]');
    expect(aiNode.exists()).toBe(true);
    expect(aiNode.text()).toContain('已掌握');
    expect(aiNode.text()).toContain('待复习');
    expect(aiNode.text()).toContain('能力 64');
    expect(aiNode.text()).toContain('讲解');
    expect(aiNode.text()).toContain('题 2');

    await wrapper.find('[data-testid="skill-area-tab-ml"]').trigger('click');
    const mlNode = wrapper.find('[data-testid="skill-node-ml.linear"]');
    expect(mlNode.exists()).toBe(true);
    expect(mlNode.text()).toContain('已解锁');
    expect(mlNode.text()).toContain('前置域 1/1');
  });
});
