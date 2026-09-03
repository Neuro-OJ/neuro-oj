/**
 * 客观题判分核心单元测试（纯函数，无需 DB）。
 * 覆盖：三题型全对/部分/全错、多选不完全匹配、卷面分 ×100、未知题目忽略。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import {
  judgePaper,
  judgeQuestion,
  type QuestionToJudge,
} from "../../src/domains/objective/index.ts";
import type { ObjectiveAnswerValue } from "./../../src/domains/objective/types/objective.ts";

function q(
  id: string,
  type: string,
  answer: ObjectiveAnswerValue[],
  explanation = "",
): QuestionToJudge {
  return { id, type, answer, explanation };
}

Deno.test("objective judge: 单选答对得满分", () => {
  const result = judgePaper({
    questions: [q("q1", "single", ["A"])],
    answers: { q1: ["A"] },
  });
  assertEquals(result.correct_count, 1);
  assertEquals(result.total_count, 1);
  assertEquals(result.score, 10000);
  assertEquals(result.details.q1.correct, true);
});

Deno.test("objective judge: 单选答错不得分", () => {
  const result = judgePaper({
    questions: [q("q1", "single", ["A"])],
    answers: { q1: ["B"] },
  });
  assertEquals(result.correct_count, 0);
  assertEquals(result.score, 0);
  assertEquals(result.details.q1.correct, false);
  assertEquals(result.details.q1.expected, ["A"]);
  assertEquals(result.details.q1.given, ["B"]);
});

Deno.test("objective judge: 判断题对/错判定", () => {
  const right = judgePaper({
    questions: [q("q1", "judge", [true])],
    answers: { q1: [true] },
  });
  assertEquals(right.details.q1.correct, true);
  assertEquals(right.score, 10000);

  const wrong = judgePaper({
    questions: [q("q1", "judge", [true])],
    answers: { q1: [false] },
  });
  assertEquals(wrong.details.q1.correct, false);
  assertEquals(wrong.score, 0);
});

Deno.test("objective judge: 多选完全匹配才得分", () => {
  const full = judgePaper({
    questions: [q("q1", "multiple", ["A", "C"])],
    answers: { q1: ["C", "A"] }, // 顺序无关
  });
  assertEquals(full.details.q1.correct, true);
  assertEquals(full.score, 10000);
});

Deno.test("objective judge: 多选少选不得分", () => {
  const result = judgePaper({
    questions: [q("q1", "multiple", ["A", "C"])],
    answers: { q1: ["A"] },
  });
  assertEquals(result.details.q1.correct, false);
  assertEquals(result.score, 0);
});

Deno.test("objective judge: 多选多选/错选不得分", () => {
  const extra = judgePaper({
    questions: [q("q1", "multiple", ["A", "C"])],
    answers: { q1: ["A", "C", "D"] },
  });
  assertEquals(extra.details.q1.correct, false);

  const wrongPick = judgePaper({
    questions: [q("q1", "multiple", ["A", "C"])],
    answers: { q1: ["A", "D"] },
  });
  assertEquals(wrongPick.details.q1.correct, false);
});

Deno.test("objective judge: 卷面分按正确数占比 ×100 换算", () => {
  // 5 题答对 3 题 → 60 分 → 6000
  const result = judgePaper({
    questions: [
      q("q1", "single", ["A"]),
      q("q2", "single", ["B"]),
      q("q3", "single", ["C"]),
      q("q4", "single", ["D"]),
      q("q5", "single", ["A"]),
    ],
    answers: { q1: ["A"], q2: ["B"], q3: ["C"], q4: ["X"], q5: ["Y"] },
  });
  assertEquals(result.correct_count, 3);
  assertEquals(result.total_count, 5);
  assertEquals(result.score, 6000);
});

Deno.test("objective judge: 未作答判错误且不得分", () => {
  const result = judgePaper({
    questions: [q("q1", "single", ["A"]), q("q2", "single", ["B"])],
    answers: { q1: ["A"] }, // q2 未作答
  });
  assertEquals(result.details.q2.correct, false);
  assertEquals(result.score, 5000);
});

Deno.test("objective judge: 未知题目 ID 忽略（不影响计分）", () => {
  const result = judgePaper({
    questions: [q("q1", "single", ["A"])],
    answers: { q1: ["A"], ghost: ["B"] },
  });
  assertEquals(result.correct_count, 1);
  assertEquals(result.score, 10000);
});

Deno.test("objective judge: 空卷得 0 分", () => {
  const result = judgePaper({ questions: [], answers: {} });
  assertEquals(result.score, 0);
  assertEquals(result.total_count, 0);
});

Deno.test("objective judge: judgeQuestion 单题判定（答案归一化）", () => {
  const judgement = judgeQuestion(
    q("q1", "multiple", ["B", "A"]),
    ["A", "B"],
  );
  assertEquals(judgement.correct, true);
  assertEquals(judgement.expected, ["B", "A"]);
  assertEquals(judgement.given, ["A", "B"]);
});

Deno.test('objective judge: judge 题型严格布尔比较（字符串 "true" 不等于 true）', () => {
  const strict = judgePaper({
    questions: [q("q1", "judge", [true])],
    answers: { q1: ["true"] }, // 字符串与布尔不等价
  });
  assertEquals(strict.details.q1.correct, false);
  assertEquals(strict.score, 0);

  const realBool = judgePaper({
    questions: [q("q1", "judge", [true])],
    answers: { q1: [true] },
  });
  assertEquals(realBool.details.q1.correct, true);
});
