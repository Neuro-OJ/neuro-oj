/**
 * problem-bundle 类型/校验单元测试。
 */
import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import { BadRequestError } from "../../../../shared/base/errors.ts";
import {
  validateBundleManifest,
  validateObjectiveQuestions,
} from "../../types/problem-bundle.ts";
import type { OiRuntimeConfig } from "../../types/runtime-config.ts";

Deno.test("validateBundleManifest: 客观题 manifest 不要求 runtime_config", () => {
  const manifest = validateBundleManifest({
    format_version: 1,
    title: "客观题套卷",
    is_objective: true,
    type: "U",
  });
  assertEquals(manifest.is_objective, true);
  assertEquals(manifest.runtime_config, undefined);
});

Deno.test("validateBundleManifest: 客观题 manifest 携带 runtime_config 被拒", () => {
  assertThrows(
    () =>
      validateBundleManifest({
        format_version: 1,
        title: "客观题套卷",
        is_objective: true,
        runtime_config: {
          evaluator: { image: "x" },
          solution: { image: "y" },
        },
      }),
    BadRequestError,
    "runtime_config",
  );
});

Deno.test("validateBundleManifest: 客观题 manifest 携带 llm/template/submission_mode/artifact_max_size_mb 被拒", () => {
  for (
    const extra of [
      { llm: { provider_id: "p", model: "m" } },
      { template: "template.py" },
      { submission_mode: "artifact" },
      { artifact_max_size_mb: 10 },
    ]
  ) {
    assertThrows(
      () =>
        validateBundleManifest({
          format_version: 1,
          title: "客观题套卷",
          is_objective: true,
          ...extra,
        }),
      BadRequestError,
    );
  }
});

Deno.test("validateBundleManifest: 非客观题仍要求 runtime_config", () => {
  assertThrows(
    () =>
      validateBundleManifest({
        format_version: 1,
        title: "编程题",
      }),
    BadRequestError,
    "runtime_config",
  );
});

const oiRuntime: OiRuntimeConfig = {
  backend: "wasm",
  languages: ["c", "cc"],
  time_limit_ms: 1000,
  memory_limit_mb: 256,
  checker: { type: "testlib", path: "checker.cpp" },
  subtasks: [
    {
      id: "basic",
      score: 40,
      cases: [{ input: "tests/1.in", output: "tests/1.out" }],
    },
    {
      id: "full",
      score: 60,
      depends_on: ["basic"],
      time_limit_ms: 2000,
      cases: [{
        input: "tests/2.in",
        output: "tests/2.out",
        memory_limit_mb: 512,
      }],
    },
  ],
};

Deno.test("validateBundleManifest: OI C/C++ 子任务配置保留全部通过与依赖信息", () => {
  const manifest = validateBundleManifest({
    format_version: 1,
    title: "A+B",
    judge_type: "oi",
    runtime_config: oiRuntime,
  });
  assertEquals(manifest.judge_type, "oi");
  assertEquals(manifest.runtime_config, oiRuntime);
});

Deno.test("validateBundleManifest: OI 配置拒绝不存在或循环依赖", () => {
  for (
    const subtasks of [
      [{
        id: "a",
        score: 100,
        depends_on: ["missing"],
        cases: [{ input: "1.in", output: "1.out" }],
      }],
      [
        {
          id: "a",
          score: 50,
          depends_on: ["b"],
          cases: [{ input: "1.in", output: "1.out" }],
        },
        {
          id: "b",
          score: 50,
          depends_on: ["a"],
          cases: [{ input: "2.in", output: "2.out" }],
        },
      ],
    ]
  ) {
    assertThrows(
      () =>
        validateBundleManifest({
          format_version: 1,
          title: "OI",
          judge_type: "oi",
          runtime_config: { ...oiRuntime, subtasks },
        }),
      BadRequestError,
      "depends_on",
    );
  }
});

Deno.test("validateBundleManifest: OI 配置拒绝不安全路径和非全过计分", () => {
  for (
    const runtime_config of [
      { ...oiRuntime, checker: { type: "testlib", path: "../checker.cpp" } },
      {
        ...oiRuntime,
        subtasks: [{
          id: "a",
          score: 100,
          cases: [{ input: "../secret.in", output: "1.out" }],
        }],
      },
      {
        ...oiRuntime,
        subtasks: [{
          id: "a",
          score: 100,
          scoring: "min",
          cases: [{ input: "1.in", output: "1.out" }],
        }],
      },
    ]
  ) {
    assertThrows(
      () =>
        validateBundleManifest({
          format_version: 1,
          title: "OI",
          judge_type: "oi",
          runtime_config,
        }),
      BadRequestError,
    );
  }
});

Deno.test("validateBundleManifest: OI 分值必须合计 100 且测试输入不得重复", () => {
  for (
    const subtasks of [
      [{
        id: "a",
        score: 90,
        cases: [{ input: "1.in", output: "1.out" }],
      }],
      [
        {
          id: "a",
          score: 50,
          cases: [{ input: "1.in", output: "1.out" }],
        },
        {
          id: "b",
          score: 50,
          cases: [{ input: "1.in", output: "2.out" }],
        },
      ],
    ]
  ) {
    assertThrows(
      () =>
        validateBundleManifest({
          format_version: 1,
          title: "OI",
          judge_type: "oi",
          runtime_config: { ...oiRuntime, subtasks },
        }),
      BadRequestError,
    );
  }
});

Deno.test("validateBundleManifest: 存量双容器题缺省 judge_type=dual", () => {
  const manifest = validateBundleManifest({
    format_version: 1,
    title: "旧题",
    runtime_config: {
      evaluator: { image: "e", time_limit_ms: 1000, memory_limit_mb: 256 },
      solution: { image: "s", call_timeout_ms: 1000, memory_limit_mb: 256 },
    },
  });
  assertEquals(manifest.judge_type, "dual");
});

Deno.test("validateBundleManifest: OI 不接受双容器专有字段", () => {
  assertThrows(
    () =>
      validateBundleManifest({
        format_version: 1,
        title: "OI",
        judge_type: "oi",
        llm: { max_calls: 1 },
        runtime_config: oiRuntime,
      }),
    BadRequestError,
    "llm",
  );
});

Deno.test("validateObjectiveQuestions: 合法小题数组通过", () => {
  const questions = validateObjectiveQuestions([
    {
      type: "single",
      prompt: "1+1=?",
      options: [{ key: "A", text: "2" }, { key: "B", text: "3" }],
      answer: ["A"],
      explanation: "因为 1+1=2",
    },
    {
      type: "judge",
      prompt: "地球是圆的",
      answer: [true],
    },
  ]);
  assertEquals(questions.length, 2);
  assertEquals(questions[0].sort_order, 0);
  assertEquals(questions[1].sort_order, 1);
});

Deno.test("validateObjectiveQuestions: 空数组被拒", () => {
  assertThrows(
    () => validateObjectiveQuestions([]),
    BadRequestError,
    "非空数组",
  );
});

Deno.test("validateObjectiveQuestions: 非法题型/答案/选项/重复 sort_order 被拒", () => {
  assertThrows(
    () =>
      validateObjectiveQuestions([
        {
          type: "single",
          prompt: "x",
          options: [{ key: "A", text: "a" }],
          answer: ["A", "B"],
        },
      ]),
    BadRequestError,
    "answer",
  );
  assertThrows(
    () =>
      validateObjectiveQuestions([
        {
          type: "single",
          prompt: "x",
          options: [{ key: "A", text: "a" }],
          answer: ["B"],
        },
      ]),
    BadRequestError,
    "不存在",
  );
  assertThrows(
    () =>
      validateObjectiveQuestions([
        {
          type: "single",
          prompt: "x",
          options: [{ key: "A", text: "a" }],
          answer: ["A"],
        },
        {
          type: "single",
          prompt: "y",
          options: [{ key: "A", text: "a" }],
          answer: ["A"],
          sort_order: 0,
        },
      ]),
    BadRequestError,
    "sort_order",
  );
});
