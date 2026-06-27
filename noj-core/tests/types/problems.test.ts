import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  isValidJudgeType,
  JUDGE_TYPES,
  type JudgeType,
} from "../../src/types/problems.ts";

/**
 * JUDGE_TYPES / isValidJudgeType 单测（issue #66）。
 *
 * 这些是 problems 服务层与 noj-judge JudgeTask 之间的契约：
 * - 服务层用 isValidJudgeType 拦截非法输入并返回 400
 * - noj-judge 端 JudgeType 枚举序列化使用相同字符串集
 */

Deno.test("JUDGE_TYPES 含 standard 与 special", () => {
  assertEquals(JUDGE_TYPES.length, 2);
  assert(JUDGE_TYPES.includes("standard"));
  assert(JUDGE_TYPES.includes("special"));
});

Deno.test("isValidJudgeType: standard / special 合法", () => {
  assertEquals(isValidJudgeType("standard"), true);
  assertEquals(isValidJudgeType("special"), true);
});

Deno.test("isValidJudgeType: 其他值非法（含空、大小写、笔误）", () => {
  assertEquals(isValidJudgeType(""), false);
  assertEquals(isValidJudgeType("Standard"), false); // 大小写敏感
  assertEquals(isValidJudgeType("spj"), false);
  assertEquals(isValidJudgeType("judge"), false);
});

Deno.test("isValidJudgeType: 解析后类型收窄为 JudgeType 联合", () => {
  // type narrowing 验证：true 分支赋值给 JudgeType 变量不应触发编译错误
  const sample: string = "standard";
  if (isValidJudgeType(sample)) {
    const narrowed: JudgeType = sample;
    assertEquals(narrowed, "standard");
  }
});
