/**
 * problem-bundle 类型/校验单元测试。
 */
import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import { BadRequestError } from "./../../src/shared/base/errors.ts";
import {
  validateBundleManifest,
  validateObjectiveQuestions,
} from "../../src/types/problem-bundle.ts";

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
