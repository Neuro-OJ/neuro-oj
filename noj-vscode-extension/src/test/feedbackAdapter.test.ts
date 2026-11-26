import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSelfTestFeedback,
  buildSubmissionFeedback,
  extractSourceLocations,
} from "../feedbackAdapter";
import { renderRadarSvg, renderReportHtml } from "../reportHtml";
import { renderMarkdownSafe, renderStatementHtml } from "../statementHtml";
import type { SelfTestDetail, SubmissionDetail } from "../types";

test("extractSourceLocations 提取 Python traceback 与行内 file:line 引用", () => {
  const locs = extractSourceLocations(
    'Traceback:\n  File "src/agent.py", line 18, in run\nsubmission.py:42 ValueError',
  );
  assert.deepEqual(locs, [
    { file: "src/agent.py", line: 18 },
    { file: "submission.py", line: 42 },
  ]);
});

test("buildSubmissionFeedback 兼容 /feedback 接口并在 404 回退时从 details 抽取报告", () => {
  const detail: SubmissionDetail = {
    id: "sub-1",
    status: "finished",
    problem_id: "p1",
    file_name: "submission.py",
    queue_position: null,
    queue_length: null,
    result: {
      status: "WA",
      score: 7500,
      output: 'File "submission.py", line 12\nWrong Answer',
      output_truncated: false,
      time_ms: 320,
      memory_kb: 2048,
      details: {
        score_content: 8000,
        score_format: 7000,
        cases: [
          { case_id: "c1", status: "AC" },
          {
            case_id: "c2",
            status: "WA",
            input: "1+1",
            expected_output: "2",
            actual_output: "3",
          },
        ],
        metering: {
          prompt_tokens: 120,
          completion_tokens: 45,
          total_tokens: 165,
          cost_usd: 0.0012,
          call_count: 2,
        },
      },
    },
  };

  // 回退路径（/feedback 返回 null）
  const fallback = buildSubmissionFeedback("main:1001 测试题", detail, null);
  assert.equal(fallback.score, 75);
  assert.equal(fallback.dimensions.length, 2);
  assert.equal(fallback.badcases.length, 1);
  assert.equal(fallback.badcases[0].caseId, "c2");
  assert.equal(fallback.badcases[0].expected, "2");
  assert.equal(fallback.metering?.totalTokens, 165);
  assert.deepEqual(fallback.locations, [{ file: "submission.py", line: 12 }]);

  // 结构化 /feedback 路径
  const rich = buildSubmissionFeedback("main:1001 测试题", detail, {
    score: 88,
    max_score: 100,
    status: "finished",
    dimensions: [
      { name: "推理", score: 90 },
      { name: "格式", score: 85 },
      { name: "速度", score: 89 },
    ],
    traces: [
      {
        model: "gpt-4o-mini",
        duration_ms: 150,
        prompt_tokens: 60,
        completion_tokens: 30,
      },
    ],
  });
  assert.equal(rich.score, 88);
  assert.equal(rich.dimensions.length, 3);
  assert.equal(rich.traces.length, 1);
});

test("buildSubmissionFeedback 对 hidden 结果彻底脱敏", () => {
  const hidden: SubmissionDetail = {
    id: "sub-h",
    problem_id: "p1",
    file_name: "submission.py",
    result_visibility: "hidden",
    queue_position: null,
    queue_length: null,
    result: {
      status: "AC",
      score: 10000,
      output: "SECRET_OUTPUT",
      output_truncated: false,
      time_ms: 10,
      memory_kb: 100,
      details: null,
    },
  };
  const fb = buildSubmissionFeedback("竞赛题", hidden, { score: 100 });
  assert.equal(fb.hidden, true);
  assert.equal(fb.score, null);
  assert.equal(fb.output, undefined);
});

test("buildSelfTestFeedback 与可视化 HTML/SVG 渲染正确且防 XSS", () => {
  const st: SelfTestDetail = {
    id: "st_1",
    problem_id: "p1",
    file_name: "submission.py",
    status: "finished",
    result_status: "AC",
    score: 10000,
    output: "ok",
    output_truncated: false,
    details: null,
    time_ms: 55,
    memory_kb: 512,
  };
  const fb = buildSelfTestFeedback("1001 · Self-Test", st, {
    dimensions: [
      { name: "正确性", score: 100 },
      { name: "稳定性", score: 90 },
      { name: "成本", score: 85 },
    ],
  });
  const svg = renderRadarSvg(fb.dimensions);
  assert.match(svg, /<svg /);
  assert.match(svg, /<polygon /);
  assert.ok(!svg.includes("#0284c7"));
  assert.match(svg, /#0369a1/);

  const html = renderReportHtml(fb, "nonce123");
  assert.match(html, /script-src 'nonce-nonce123'/);
  assert.match(html, /100\.00 \/ 100/);
  assert.ok(html.includes("#0369a1"));
  assert.ok(html.includes("#047857"));
  assert.ok(!html.includes("#0284c7"));
  assert.ok(!html.includes("#059669"));
  assert.ok(html.includes("#f7f8fa"));
  assert.ok(html.includes("#f1f5f9"));
  assert.ok(html.includes("#e2e8f0"));
  assert.ok(html.includes("#b45309"));
  assert.ok(html.includes("#be123c"));
  assert.ok(html.includes("#0b1120"));
  assert.ok(html.includes("#111827"));
  assert.ok(html.includes("#070b14"));
  assert.ok(html.includes("#38bdf8"));
  assert.ok(html.includes("#00e07a"));
  assert.ok(html.includes("#fbbf24"));
  assert.ok(html.includes("#fb7185"));

  const stmt = renderStatementHtml(
    {
      version_id: "v1",
      version: 2,
      submission_mode: "artifact",
      judge_type: "dual",
      content: {
        title: '<script>alert("xss")</script>',
        description:
          "# 标题\n\n> 引用提示\n\n<img src=x onerror=alert(1)> **加粗**",
        samples: [{ input: "a", output: "b" }],
      },
    },
    { domainSlug: "school", reference: "main:1001" },
  );
  assert.ok(!stmt.includes("<script>alert"));
  assert.ok(!stmt.includes("<img src=x"));
  assert.match(stmt, /&lt;script&gt;alert/);
  assert.ok(stmt.includes("#0369a1"));
  assert.ok(stmt.includes("#047857"));
  assert.ok(!stmt.includes("#0284c7"));
  assert.ok(!stmt.includes("#059669"));
  assert.ok(!stmt.includes("border-left: 3px"));
  assert.match(
    renderMarkdownSafe("[ok](javascript:alert(1))"),
    /javascript:alert/,
  );
  assert.ok(!renderMarkdownSafe("[ok](javascript:alert(1))").includes("<a "));
});

test("buildSubmissionFeedback 精准对齐 Core evaluation-feedback 切片契约", () => {
  const detail: SubmissionDetail = {
    id: "sub-core-1",
    problem_id: "p1",
    file_name: "agent.py",
    status: "finished",
    result_visibility: "cases",
    queue_position: null,
    queue_length: null,
    result: {
      status: "finished",
      score: 8200,
      output: "ok",
      output_truncated: false,
      time_ms: 420,
      memory_kb: 4096,
      details: null,
    },
  };
  const coreFeedback = {
    visible: true,
    visibility: "cases",
    attempt_id: "att-1",
    gateway_available: true,
    summary: {
      total_calls: 3,
      error_calls: 1,
      prompt_tokens: 1000,
      completion_tokens: 400,
      cached_prompt_tokens: 100,
      total_tokens: 1400,
      estimated_cost: 0.0042,
      total_latency_ms: 950,
      avg_latency_ms: 317,
      p95_latency_ms: 520,
      models: [
        {
          model: "gpt-4o-mini",
          calls: 3,
          total_tokens: 1400,
          estimated_cost: 0.0042,
        },
      ],
    },
    metrics: [
      { key: "acc", label: "准确率", score: 85, max_score: 100 },
      { key: "fmt", label: "格式合规", score: 90, max_score: 100 },
      { key: "cost", label: "成本效率", score: 72, max_score: 100 },
    ],
    traces: [
      {
        id: "t1",
        seq: 1,
        model: "gpt-4o-mini",
        status: "ok",
        error_code: null,
        prompt_tokens: 400,
        completion_tokens: 150,
        cached_prompt_tokens: 0,
        total_tokens: 550,
        estimated_cost: 0.0016,
        latency_ms: 310,
        offset_ms: 0,
        created_at: "2026-11-24T00:00:00Z",
        request_messages: [{ role: "user", content: "hello" }],
      },
    ],
    badcases: [
      {
        case_id: "case-3",
        status: "WA",
        score: 40,
        max_score: 100,
        error_type: "FORMAT_ERROR",
        reasoning: 'File "agent.py", line 27 缺少 JSON 字段',
        input: "prompt",
        expected_output: '{"ok":true}',
        actual_output: "ok",
        time_ms: 120,
        memory_kb: 1024,
      },
    ],
  };

  const fb = buildSubmissionFeedback("school:101", detail, coreFeedback);
  assert.equal(fb.score, 82);
  assert.equal(fb.metering?.callCount, 3);
  assert.equal(fb.metering?.totalTokens, 1400);
  assert.equal(fb.metering?.costUsd, 0.0042);
  assert.equal(fb.dimensions.length, 3);
  assert.equal(fb.dimensions[0].name, "准确率");
  assert.equal(fb.traces.length, 1);
  assert.equal(fb.traces[0].index, 1);
  assert.equal(fb.traces[0].durationMs, 310);
  assert.match(fb.traces[0].requestPreview, /hello/);
  assert.equal(fb.badcases.length, 1);
  assert.match(fb.badcases[0].message ?? "", /\[FORMAT_ERROR\]/);
  assert.deepEqual(fb.locations, [{ file: "agent.py", line: 27 }]);
});
