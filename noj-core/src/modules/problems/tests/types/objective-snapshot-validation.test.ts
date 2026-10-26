/**
 * 客观题快照验证器测试（tracking #17）。
 *
 * 发布验证必须与小题编辑器**同一套规则**：直接 PUT 草稿不能绕过编辑器校验并发布
 * 无法正常判卷的小题。覆盖缺选项、答案引用不存在的选项、single 多答案、judge 非
 * 布尔、排序号重复等场景。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { BadRequestError } from "../../../../shared/base/errors.ts";
import { validateObjectiveQuestionSnapshots } from "../../types/problem-content.ts";

/** 合法单选题快照。 */
function single(overrides: Record<string, unknown> = {}) {
  return {
    key: "q1",
    sort_order: 0,
    type: "single",
    prompt: "1+1=?",
    options: [{ key: "A", text: "2" }, { key: "B", text: "3" }],
    answer: ["A"],
    explanation: "",
    ...overrides,
  };
}

/** 断言校验抛出 BadRequestError，并包含关键字。 */
function assertRejected(value: unknown, keyword: string): void {
  let error: unknown;
  try {
    validateObjectiveQuestionSnapshots(value);
  } catch (err) {
    error = err;
  }
  assertEquals(error instanceof BadRequestError, true, `应拒绝：${keyword}`);
  assertEquals(
    (error as Error).message.includes(keyword),
    true,
    `错误信息应包含「${keyword}」，实际：${(error as Error).message}`,
  );
}

Deno.test("objective snapshot: 合法快照通过校验", () => {
  validateObjectiveQuestionSnapshots([single()]);
  validateObjectiveQuestionSnapshots([
    single({ key: "j1", type: "judge", answer: [true], options: undefined }),
  ]);
  validateObjectiveQuestionSnapshots([
    single({ key: "m1", type: "multiple", answer: ["A", "B"] }),
  ]);
});

Deno.test("objective snapshot: 空数组 / 缺 key / key 重复被拒", () => {
  assertRejected([], "至少包含一道小题");
  assertRejected([single({ key: "" })], "稳定 key");
  assertRejected([single(), { ...single(), sort_order: 1 }], "key 重复");
});

Deno.test("objective snapshot: 缺选项 / 选项非法被拒", () => {
  assertRejected([single({ options: undefined })], "缺少选项");
  assertRejected([single({ options: [{ key: "", text: "x" }] })], "选项不合法");
  assertRejected(
    [single({ options: [{ key: "A", text: 1 }] })],
    "选项不合法",
  );
});

Deno.test("objective snapshot: 答案引用不存在的选项被拒", () => {
  assertRejected([single({ answer: ["C"] })], "答案选项不存在");
});

Deno.test("objective snapshot: single 多答案 / 空答案被拒", () => {
  assertRejected([single({ answer: ["A", "B"] })], "恰好一个");
  assertRejected([single({ answer: [] })], "非空数组");
  assertRejected([single({ answer: ["A", "A"] })], "重复");
});

Deno.test("objective snapshot: judge 非布尔答案被拒", () => {
  assertRejected(
    [single({ type: "judge", answer: ["true"], options: undefined })],
    "判断题答案",
  );
  assertRejected(
    [single({ type: "judge", answer: [], options: undefined })],
    "非空数组",
  );
});

Deno.test("objective snapshot: 题型非法 / 题干为空 / 排序号非法被拒", () => {
  assertRejected([single({ type: "essay" })], "题型不合法");
  assertRejected([single({ prompt: "" })], "缺少题干");
  assertRejected([single({ sort_order: -1 })], "排序号");
  assertRejected([single({ sort_order: 1.5 })], "排序号");
  assertRejected(
    [single(), single({ key: "q2" })],
    "排序号重复",
  );
});
