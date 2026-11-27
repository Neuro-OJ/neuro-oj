import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import AiFeedbackPanel from '~/components/submission/AiFeedbackPanel.vue';
import MetricRadarChart from '~/components/submission/MetricRadarChart.vue';
import LlmTraceTimeline from '~/components/submission/LlmTraceTimeline.vue';
import BadcaseComparison from '~/components/submission/BadcaseComparison.vue';
import SubmissionCaseResults from '~/components/submission/SubmissionCaseResults.vue';
import { useSubmissionFeedback } from '~/composables/useSubmissionFeedback';
import type { EvaluationFeedback } from '~/utils/domain/submission/aiFeedback';

vi.mock('~/composables/useToast', () => ({
  useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }),
}));

const stubs = {
  UIcon: { props: ['name'], template: '<i :data-icon="name" />' },
  UBadge: { template: '<span><slot /></span>' },
  UButton: {
    props: ['disabled'],
    emits: ['click'],
    template: '<button type="button" :disabled="disabled" @click="$emit(\'click\', $event)"><slot /></button>',
  },
  UInput: {
    props: ['modelValue', 'placeholder'],
    emits: ['update:modelValue'],
    template:
      '<input :value="modelValue" :placeholder="placeholder" @input="$emit(\'update:modelValue\', ($event.target).value)" />',
  },
};

const sampleFeedback: EvaluationFeedback = {
  visible: true,
  visibility: 'cases',
  attempt_id: 'att-1',
  gateway_available: true,
  summary: {
    total_calls: 2,
    error_calls: 1,
    prompt_tokens: 150,
    completion_tokens: 50,
    cached_prompt_tokens: 30,
    total_tokens: 200,
    estimated_cost: 12,
    total_latency_ms: 420,
    avg_latency_ms: 210,
    p95_latency_ms: 300,
    models: [{ model: 'deepseek-chat', calls: 2, total_tokens: 200, estimated_cost: 12 }],
  },
  metrics: [
    { key: 'accuracy', label: '准确率', score: 80, max_score: 100 },
    { key: 'format', label: '格式合规', score: 90, max_score: 100 },
    { key: 'speed', label: '响应效率', score: 70, max_score: 100 },
  ],
  traces: [
    {
      id: 'tr-1',
      seq: 1,
      model: 'deepseek-chat',
      status: 'ok',
      error_code: null,
      prompt_tokens: 100,
      completion_tokens: 40,
      cached_prompt_tokens: 30,
      total_tokens: 140,
      estimated_cost: 8,
      latency_ms: 120,
      offset_ms: 0,
      created_at: '2026-11-24T10:00:00.000Z',
      request_params: { temperature: 0 },
      request_messages: [{ role: 'user', content: '脱敏提示词' }],
    },
    {
      id: 'tr-2',
      seq: 2,
      model: 'deepseek-chat',
      status: 'error',
      error_code: 'upstream_500',
      prompt_tokens: 50,
      completion_tokens: 10,
      cached_prompt_tokens: 0,
      total_tokens: 60,
      estimated_cost: 4,
      latency_ms: 300,
      offset_ms: 200,
      created_at: '2026-11-24T10:00:00.200Z',
      request_params: { temperature: 0 },
    },
  ],
  badcases: [
    {
      case_id: 'case-wa',
      status: 'WA',
      score: 0,
      max_score: 100,
      error_type: 'json_parse_error',
      reasoning: '输出缺少 answer 字段',
      input: '{"q":"1+1"}',
      expected_output: '{"answer":2}\nline2',
      actual_output: '{"ans":2}\nline2',
      time_ms: 45,
      memory_kb: 512,
    },
    {
      case_id: 'case-partial',
      status: 'AC',
      score: 60,
      max_score: 100,
      error_type: 'partial_match',
      reasoning: '部分维度未满分',
      input: null,
      expected_output: 'ok',
      actual_output: 'ok',
      time_ms: 30,
      memory_kb: 256,
    },
  ],
};

describe('AI 评测可视化反馈组件', () => {
  it('MetricRadarChart 支持 3+ 维度 SVG 渲染与悬停高亮，不足 3 维降级为条形图', async () => {
    const radar = mount(MetricRadarChart, {
      props: { metrics: sampleFeedback.metrics },
      global: { stubs },
    });
    expect(radar.find('svg').exists()).toBe(true);
    expect(radar.findAll('circle')).toHaveLength(6); // 3 个可见顶点 + 3 个透明交互热区
    await radar.findAll('circle[tabindex="0"]')[1]!.trigger('mouseenter');
    expect(radar.text()).toContain('格式合规');
    expect(radar.text()).toContain('90 / 100');

    const fallback = mount(MetricRadarChart, {
      props: { metrics: sampleFeedback.metrics.slice(0, 2) },
      global: { stubs },
    });
    expect(fallback.find('svg').exists()).toBe(false);
    expect(fallback.text()).toContain('准确率');
    expect(fallback.text()).toContain('格式合规');
  });

  it('LlmTraceTimeline 展示总览胶囊、瀑布流并可展开脱敏消息与错误详情', async () => {
    const timeline = mount(LlmTraceTimeline, {
      props: {
        summary: sampleFeedback.summary,
        traces: sampleFeedback.traces,
      },
      global: { stubs },
    });
    expect(timeline.text()).toContain('200');
    expect(timeline.text()).toContain('12 单位');
    expect(timeline.text()).toContain('P95 300ms');

    const buttons = timeline.findAll('button');
    await buttons[0]!.trigger('click');
    expect(timeline.text()).toContain('脱敏提示词');
    expect(timeline.text()).toContain('"temperature": 0');

    await buttons[1]!.trigger('click');
    expect(timeline.text()).toContain('upstream_500');
    expect(timeline.text()).toContain('请求消息正文已按可见性或安全策略省略');
  });

  it('BadcaseComparison 支持筛选未通过/未满分用例与 Expected/Actual 对比', async () => {
    const comp = mount(BadcaseComparison, {
      props: { badcases: sampleFeedback.badcases },
      global: { stubs },
    });
    expect(comp.text()).toContain('case-wa');
    expect(comp.text()).toContain('case-partial');
    expect(comp.text()).toContain('json_parse_error');
    expect(comp.text()).toContain('输出缺少 answer 字段');

    const failedBtn = comp.findAll('button').find((b) => b.text().includes('未通过'));
    await failedBtn!.trigger('click');
    expect(comp.text()).toContain('case-wa');
    expect(comp.text()).not.toContain('case-partial');
  });

  it('AiFeedbackPanel 严格遵循 hidden / summary / cases 可见性门控', () => {
    const full = mount(AiFeedbackPanel, {
      props: {
        kind: 'submission',
        targetId: 'sub-1',
        resultVisibility: 'cases',
        resourceAvailable: true,
        feedback: sampleFeedback,
      },
      global: { stubs },
    });
    expect(full.text()).toContain('AI 评测可视化反馈');
    expect(full.text()).toContain('分项能力雷达图');
    expect(full.text()).toContain('LLM 调用与成本概览');
    expect(full.text()).toContain('可见 Badcase 对比');

    const summaryOnly = mount(AiFeedbackPanel, {
      props: {
        kind: 'submission',
        targetId: 'sub-1',
        resultVisibility: 'summary',
        resourceAvailable: true,
        feedback: {
          ...sampleFeedback,
          visibility: 'summary',
          traces: [],
          badcases: [],
        },
      },
      global: { stubs },
    });
    expect(summaryOnly.text()).toContain('仅摘要模式');
    expect(summaryOnly.text()).toContain('分项能力雷达图');
    expect(summaryOnly.text()).not.toContain('可见 Badcase 对比');
    expect(summaryOnly.text()).not.toContain('脱敏提示词');

    const hidden = mount(AiFeedbackPanel, {
      props: {
        kind: 'submission',
        targetId: 'sub-1',
        resultVisibility: 'hidden',
        resourceAvailable: true,
        feedback: sampleFeedback,
      },
      global: { stubs },
    });
    expect(hidden.text()).toBe('');

    const revoked = mount(AiFeedbackPanel, {
      props: {
        kind: 'submission',
        targetId: 'sub-1',
        resultVisibility: 'cases',
        resourceAvailable: false,
        feedback: sampleFeedback,
      },
      global: { stubs },
    });
    expect(revoked.text()).toBe('');
  });

  it('SubmissionCaseResults 仅对非隐藏用例展示 error_type 与 reasoning', async () => {
    const view = mount(SubmissionCaseResults, {
      props: {
        details: {
          cases: [
            {
              case_id: 'vis-1',
              status: 'WA',
              visibility: 'visible',
              error_type: 'format_error',
              reasoning: '缺少 JSON 尾括号',
              expected_output: '{}',
              actual_output: '{',
            },
            {
              case_id: 'hid-1',
              status: 'WA',
              visibility: 'hidden',
              error_type: 'hidden_error_type',
              reasoning: 'hidden_reasoning_secret',
            },
          ],
        },
      },
      global: { stubs },
    });

    expect(view.text()).toContain('format_error');
    expect(view.text()).not.toContain('hidden_error_type');
    expect(view.text()).not.toContain('hidden_reasoning_secret');

    const rows = view.findAll('tbody tr');
    await rows[0]!.trigger('click');
    expect(view.text()).toContain('缺少 JSON 尾括号');
  });

  it('SubmissionCaseResults 仅对非隐藏用例展开展示调试输出 stdout', async () => {
    const view = mount(SubmissionCaseResults, {
      props: {
        details: {
          cases: [
            {
              case_id: 'vis-log',
              status: 'Accepted',
              visibility: 'visible',
              stdout: 'visible-print-output',
              stdout_truncated: true,
            },
            {
              case_id: 'hid-log',
              status: 'Accepted',
              visibility: 'hidden',
              stdout: 'hidden-print-secret',
            },
          ],
        },
      },
      global: { stubs },
    });

    expect(view.text()).toContain('查看调试输出');
    expect(view.text()).not.toContain('hidden-print-secret');

    const rows = view.findAll('tbody tr');
    await rows[0]!.trigger('click');
    expect(view.text()).toContain('visible-print-output');
    expect(view.text()).toContain('调试输出已截断');

    await rows[1]!.trigger('click');
    expect(view.text()).not.toContain('hidden-print-secret');
  });

  it('useSubmissionFeedback 使用 useApi 请求反馈并在错误时降级为 null', async () => {
    const mockGet = vi.fn().mockResolvedValueOnce({ data: sampleFeedback }).mockRejectedValueOnce(new Error('503'));
    vi.stubGlobal('useApi', () => ({ api: { get: mockGet } }));

    const client = useSubmissionFeedback();
    const ok = await client.loadFeedback({
      slug: 'main',
      id: 'sub-1',
      kind: 'submission',
      attemptId: 'att-1',
      includeMessages: true,
    });
    expect(ok?.visible).toBe(true);
    expect(mockGet).toHaveBeenCalledWith(
      '/api/v1/domains/main/submissions/sub-1/feedback',
      expect.objectContaining({
        query: { attempt_id: 'att-1', include_messages: '1' },
        silent: true,
        redirectOnUnauthorized: false,
      }),
    );

    const degraded = await client.loadFeedback({
      slug: 'main',
      id: 'st-1',
      kind: 'self-test',
    });
    expect(degraded).toBeNull();
    expect(client.feedback.value).toBeNull();
    expect(client.error.value).toBeInstanceOf(Error);
  });

  it('useSubmissionFeedback 丢弃乱序晚到的旧响应与过期错误并中止前序请求', async () => {
    const createDeferred = <T>() => {
      let resolve!: (value: T) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    };

    const pendingSlow = createDeferred<{ data: unknown }>();
    const finishedFast = createDeferred<{ data: unknown }>();
    const signals: Array<AbortSignal | undefined> = [];

    const mockGet = vi.fn()
      .mockImplementationOnce((_url: string, opts?: { signal?: AbortSignal }) => {
        signals.push(opts?.signal);
        return pendingSlow.promise;
      })
      .mockImplementationOnce((_url: string, opts?: { signal?: AbortSignal }) => {
        signals.push(opts?.signal);
        return finishedFast.promise;
      });
    vi.stubGlobal('useApi', () => ({ api: { get: mockGet } }));

    const pendingSnapshot: EvaluationFeedback = {
      ...sampleFeedback,
      attempt_id: 'att-pending',
      traces: [],
      badcases: [],
    };
    const finishedSnapshot: EvaluationFeedback = {
      ...sampleFeedback,
      attempt_id: 'att-finished',
    };

    const client = useSubmissionFeedback();

    // 1. 先发出慢请求（pending 状态）
    const slowPromise = client.loadFeedback({
      slug: 'main',
      id: 'sub-race',
      kind: 'submission',
      attemptId: 'att-pending',
    });
    expect(client.loading.value).toBe(true);
    expect(signals[0]?.aborted).toBe(false);

    // 2. 再发出快请求（finished 状态），应立即中止前一次未完成请求
    const fastPromise = client.loadFeedback({
      slug: 'main',
      id: 'sub-race',
      kind: 'submission',
      attemptId: 'att-finished',
    });
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);

    // 3. 快请求先响应完成态反馈
    finishedFast.resolve({ data: finishedSnapshot });
    const fastResult = await fastPromise;
    expect(fastResult?.attempt_id).toBe('att-finished');
    expect(client.feedback.value?.attempt_id).toBe('att-finished');
    expect(client.loading.value).toBe(false);
    expect(client.error.value).toBeNull();

    // 4. 慢请求最后才 resolve（旧快照），不得覆盖已完成态反馈
    pendingSlow.resolve({ data: pendingSnapshot });
    const slowResult = await slowPromise;
    expect(slowResult).toBeNull();
    expect(client.feedback.value?.attempt_id).toBe('att-finished');
    expect(client.feedback.value?.traces).toHaveLength(2);
    expect(client.loading.value).toBe(false);
    expect(client.error.value).toBeNull();
  });

  it('useSubmissionFeedback 丢弃已被新请求取代的慢请求错误', async () => {
    const createDeferred = <T>() => {
      let resolve!: (value: T) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    };

    const slowErrDeferred = createDeferred<{ data: unknown }>();
    const fastOkDeferred = createDeferred<{ data: unknown }>();

    const mockGet = vi.fn()
      .mockImplementationOnce(() => slowErrDeferred.promise)
      .mockImplementationOnce(() => fastOkDeferred.promise);
    vi.stubGlobal('useApi', () => ({ api: { get: mockGet } }));

    const client = useSubmissionFeedback();
    const slowPromise = client.loadFeedback({ slug: 'main', id: 'sub-err', kind: 'submission' });
    const fastPromise = client.loadFeedback({ slug: 'main', id: 'sub-err', kind: 'submission' });

    fastOkDeferred.resolve({ data: sampleFeedback });
    await fastPromise;
    expect(client.feedback.value?.attempt_id).toBe('att-1');
    expect(client.error.value).toBeNull();

    slowErrDeferred.reject(new Error('late abort or timeout'));
    await slowPromise;
    expect(client.feedback.value?.attempt_id).toBe('att-1');
    expect(client.error.value).toBeNull();
    expect(client.loading.value).toBe(false);
  });
});
