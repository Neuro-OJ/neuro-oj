/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assertEquals } from 'jsr:@std/assert@^1';
import {
  computeLineDiff,
  computeRadarGeometry,
  computeTraceBarStyle,
  computeTraceSpanMs,
  formatFeedbackCost,
  formatFeedbackTokens,
  normalizeFeedbackPayload,
} from '../../../utils/domain/submission/aiFeedback.ts';
import { normalizeSubmissionCases } from '../../../utils/domain/submission/submissionCaseResults.ts';

Deno.test('aiFeedback: normalizeFeedbackPayload 在 hidden 时剥离全部敏感数据', () => {
  const hidden = normalizeFeedbackPayload({
    visible: false,
    visibility: 'hidden',
    summary: { total_calls: 3 },
    metrics: [{ key: 'a', label: 'A', score: 1, max_score: 1 }],
    traces: [{ id: 't1' }],
    badcases: [{ case_id: 'c1', status: 'WA' }],
  });
  assertEquals(hidden, {
    visible: false,
    visibility: 'hidden',
    attempt_id: null,
    gateway_available: false,
    summary: null,
    metrics: [],
    traces: [],
    badcases: [],
  });
});

Deno.test('aiFeedback: computeRadarGeometry 为 3+ 维度生成闭合多边形', () => {
  const tooFew = computeRadarGeometry([
    { key: 'a', label: 'A', score: 80, max_score: 100 },
    { key: 'b', label: 'B', score: 60, max_score: 100 },
  ]);
  assertEquals(tooFew.polygonPoints, '');
  assertEquals(tooFew.axes.length, 0);

  const geo = computeRadarGeometry([
    { key: 'pass', label: '通过率', score: 100, max_score: 100 },
    { key: 'cost', label: '成本', score: 50, max_score: 100 },
    { key: 'speed', label: '速度', score: 75, max_score: 100 },
  ]);
  assertEquals(geo.rings.length, 4);
  assertEquals(geo.axes.length, 3);
  assertEquals(geo.axes[0]!.percent, 100);
  assertEquals(geo.axes[1]!.percent, 50);
  assertEquals(geo.polygonPoints.split(' ').length, 3);
});

Deno.test('aiFeedback: 瀑布流偏移与行级 Diff 计算', () => {
  const span = computeTraceSpanMs([
    {
      id: 't1',
      seq: 1,
      model: 'gpt-4o',
      status: 'ok',
      error_code: null,
      prompt_tokens: 10,
      completion_tokens: 5,
      cached_prompt_tokens: 0,
      total_tokens: 15,
      estimated_cost: 1,
      latency_ms: 200,
      offset_ms: 0,
      created_at: '',
      request_params: {},
    },
    {
      id: 't2',
      seq: 2,
      model: 'gpt-4o',
      status: 'ok',
      error_code: null,
      prompt_tokens: 10,
      completion_tokens: 5,
      cached_prompt_tokens: 0,
      total_tokens: 15,
      estimated_cost: 1,
      latency_ms: 300,
      offset_ms: 500,
      created_at: '',
      request_params: {},
    },
  ]);
  assertEquals(span, 800);
  assertEquals(computeTraceBarStyle({ offset_ms: 500, latency_ms: 300 }, span), {
    leftPercent: 62.5,
    widthPercent: 37.5,
  });

  const diff = computeLineDiff('a\nb\nc', 'a\nx\nc');
  assertEquals(diff.map((d) => `${d.type}:${d.text}`), [
    'equal:a',
    'removed:b',
    'added:x',
    'equal:c',
  ]);
  assertEquals(formatFeedbackTokens(125000), '125.0k');
  assertEquals(formatFeedbackCost(42), '42 单位');
});

Deno.test('submissionCaseResults: 可见用例保留 errorType 与 reasoning，隐藏用例清除', () => {
  const rows = normalizeSubmissionCases({
    cases: [
      {
        case_id: 'v1',
        status: 'WA',
        visibility: 'visible',
        error_type: 'json_schema_error',
        reasoning: '缺少 answer 字段',
      },
      {
        case_id: 'h1',
        status: 'WA',
        visibility: 'hidden',
        error_type: 'secret_type',
        reasoning: 'secret_reason',
      },
    ],
  });
  assertEquals(rows[0]!.errorType, 'json_schema_error');
  assertEquals(rows[0]!.reasoning, '缺少 answer 字段');
  assertEquals(rows[1]!.errorType, undefined);
  assertEquals(rows[1]!.reasoning, undefined);
});
