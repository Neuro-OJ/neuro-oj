/**
 * V2 知识图谱组件测试：摸底诊断弹窗 + 评测错因知识补强面板。
 */
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import KnowledgeDiagnosticModal from '~/components/knowledge/KnowledgeDiagnosticModal.vue';
import FeedbackKnowledgeRemediation from '~/components/submission/FeedbackKnowledgeRemediation.vue';

const mockLoadDiagnosticPlan = vi.fn();
const mockSubmitSelfAssessment = vi.fn();
const mockLoadProblemRemediation = vi.fn();

vi.stubGlobal('useKnowledge', () => ({
  disabled: ref(false),
  loadDiagnosticPlan: mockLoadDiagnosticPlan,
  submitSelfAssessment: mockSubmitSelfAssessment,
  loadProblemRemediation: mockLoadProblemRemediation,
}));

const stubs = {
  NuxtLink: {
    props: ['to'],
    template: '<a :href="to"><slot /></a>',
  },
  UAlert: {
    props: ['title', 'description'],
    template: '<div role="alert">{{ title }} {{ description }}</div>',
  },
  UBadge: {
    props: ['color'],
    template: '<span data-badge :data-color="color"><slot /></span>',
  },
  UButton: {
    props: ['disabled', 'loading'],
    emits: ['click'],
    template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
  },
  UCard: {
    template: '<section><slot /></section>',
  },
  UIcon: {
    template: '<i />',
  },
  UModal: {
    props: ['open', 'title', 'description'],
    template:
      '<div v-if="open" data-testid="diagnostic-modal"><h2>{{ title }}</h2><p>{{ description }}</p><slot name="body" /><slot name="footer" /></div>',
  },
};

describe('KnowledgeDiagnosticModal', () => {
  beforeEach(() => {
    mockLoadDiagnosticPlan.mockReset();
    mockSubmitSelfAssessment.mockReset();
  });

  it('加载摸底计划、勾选领域/节点并提交替换模式自评', async () => {
    mockLoadDiagnosticPlan.mockResolvedValue({
      domain: { id: 'd1', slug: 'ai-camp' },
      placed_nodes: [],
      areas: [
        {
          area_id: 'prog',
          name: '编程与工具',
          total_nodes: 2,
          foundation_node_ids: ['prog.python-basics', 'prog.numpy'],
          mastered_count: 0,
          placed_count: 0,
        },
      ],
      checkpoints: [
        {
          node_id: 'math.linear-algebra',
          name: '向量与矩阵运算',
          area: 'math',
          area_name: '数学基础',
          summary: '矩阵乘法与逆矩阵',
          has_doc: true,
          unlocks_count: 14,
          problem_count: 2,
          sample_problem: null,
          state: 'none',
          placed: false,
        },
      ],
    });
    mockSubmitSelfAssessment.mockResolvedValue({
      placed_nodes: ['prog.python-basics', 'prog.numpy', 'math.linear-algebra'],
      added_count: 3,
      total_placed: 3,
    });

    const wrapper = mount(KnowledgeDiagnosticModal, {
      props: { open: true, slug: 'ai-camp' },
      global: { stubs },
    });
    await flushPromises();

    expect(mockLoadDiagnosticPlan).toHaveBeenCalledWith('ai-camp');
    await wrapper.get('[data-testid="diagnostic-area-toggle"]').trigger('click');
    await wrapper.get('[data-testid="diagnostic-checkpoint-toggle"]').trigger('click');
    await wrapper.get('[data-testid="diagnostic-submit"]').trigger('click');
    await flushPromises();

    expect(mockSubmitSelfAssessment).toHaveBeenCalledWith({
      node_ids: ['prog.python-basics', 'prog.numpy', 'math.linear-algebra'],
      mode: 'replace',
    });
    expect(wrapper.emitted('saved')).toBeTruthy();
  });
});

describe('FeedbackKnowledgeRemediation', () => {
  beforeEach(() => {
    mockLoadProblemRemediation.mockReset();
  });

  it('汇总 badcase error_type 与薄弱指标并渲染补强链接', async () => {
    mockLoadProblemRemediation.mockResolvedValue({
      problem_id: 'p-1',
      items: [
        {
          node_id: 'llm-infer.structured-output',
          name: '结构化输出与答案抽取',
          area: 'llm-infer',
          summary: '约束输出 JSON Schema',
          has_doc: true,
          reason: 'feedback_signal',
          matched_signals: ['json_format_error'],
          state: 'none',
          placed: false,
        },
      ],
    });

    const wrapper = mount(FeedbackKnowledgeRemediation, {
      props: {
        problemId: 'p-1',
        slug: 'ai-camp',
        badcases: [
          {
            case_id: 'case-1',
            status: 'wrong_answer',
            score: 0,
            max_score: 100,
            error_type: 'json_format_error',
            reasoning: '缺少闭合括号',
            input: null,
            expected_output: null,
            actual_output: null,
            time_ms: null,
            memory_kb: null,
          },
        ],
        metrics: [
          { key: 'format_accuracy', label: '格式准确率', score: 20, max_score: 100 },
          { key: 'latency', label: '延迟达标率', score: 95, max_score: 100 },
        ],
      },
      global: { stubs },
    });
    await flushPromises();

    expect(mockLoadProblemRemediation).toHaveBeenCalledWith('p-1', {
      domain: 'ai-camp',
      errorTypes: ['json_format_error'],
      weakMetrics: ['format_accuracy'],
    });
    const link = wrapper.get('[data-testid="remediation-node-item"] a');
    expect(link.attributes('href')).toBe('/d/ai-camp/knowledge/llm-infer.structured-output');
    expect(wrapper.text()).toContain('结构化输出与答案抽取');
    expect(wrapper.text()).toContain('错因关联');
  });
});
