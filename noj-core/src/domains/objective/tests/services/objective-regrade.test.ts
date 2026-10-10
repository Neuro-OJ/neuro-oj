/**
 * 客观题按版本快照重判测试（Handbook §6.4）。
 *
 * 覆盖 key 匹配、新增小题按未作答、删除小题不计分、答案形式不兼容、
 * 卷面分分母随目标版本变化、原始 answers 不被改写。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { regradeAgainstSnapshot } from "../../services/versioning/objective-regrade.ts";
import type { ObjectiveQuestionSnapshot } from "../../../catalog/index.ts";
import type { ObjectiveAnswerValue } from "../../types/objective.ts";

function question(
  key: string,
  type: ObjectiveQuestionSnapshot["type"],
  answer: ObjectiveAnswerValue[],
  sort = 0,
): ObjectiveQuestionSnapshot {
  return {
    key,
    sort_order: sort,
    type,
    prompt: `${key} 题干`,
    options: type === "judge"
      ? [{ key: "true", text: "正确" }, { key: "false", text: "错误" }]
      : [{ key: "A", text: "a" }, { key: "B", text: "b" }],
    answer,
    explanation: "",
  };
}

Deno.test("regrade: key 相同且答案正确得满分", () => {
  const questions = [
    question("k1", "single", ["A"], 0),
    question("k2", "judge", [true], 1),
  ];
  const out = regradeAgainstSnapshot({
    k1: ["A"],
    k2: [true],
  }, questions);
  assertEquals(out.score, 10000);
  assertEquals(out.correct_count, 2);
  assertEquals(out.total_count, 2);
  assertEquals(out.matched_count, 2);
  assertEquals(out.details.k1.match, "matched");
});

Deno.test("regrade: 新增小题按未作答（分母变大）", () => {
  const questions = [
    question("k1", "single", ["A"], 0),
    question("k2", "single", ["B"], 1), // V2 新增，用户没有答案
  ];
  const out = regradeAgainstSnapshot({ k1: ["A"] }, questions);
  assertEquals(out.score, 5000);
  assertEquals(out.missing_count, 1);
  assertEquals(out.details.k2.match, "missing_answer");
  assertEquals(out.details.k2.given, []);
  assertEquals(out.details.k2.reason_code, "MISSING_ANSWER");
});

Deno.test("regrade: 删除的小题不计分且答案被忽略", () => {
  const questions = [question("k1", "single", ["A"], 0)];
  const out = regradeAgainstSnapshot({ k1: ["A"], gone: ["B"] }, questions);
  assertEquals(out.total_count, 1);
  assertEquals(out.score, 10000);
  assertEquals(out.ignored_keys, ["gone"]);
});

Deno.test("regrade: 答案形式与目标题型不兼容按未作答", () => {
  const questions = [
    // V1 是 single（字符串），V2 改成 judge（布尔）
    question("k1", "judge", [true], 0),
    question("k2", "single", ["A"], 1),
  ];
  const out = regradeAgainstSnapshot({
    k1: ["A"], // 旧形式：字符串
    k2: [true as unknown as ObjectiveAnswerValue], // 旧形式：布尔
  }, questions);
  assertEquals(out.incompatible_count, 2);
  assertEquals(out.score, 0);
  assertEquals(out.details.k1.reason_code, "INCOMPATIBLE_ANSWER_FORM");
  // 原始答案保留在详情里（便于申诉与审计），但按未作答计分
  assertEquals(out.details.k1.given, ["A"]);
});

Deno.test("regrade: 空卷返回 0 分且不抛错", () => {
  const out = regradeAgainstSnapshot({ k1: ["A"] }, []);
  assertEquals(out.score, 0);
  assertEquals(out.total_count, 0);
  assertEquals(out.ignored_keys, ["k1"]);
});

Deno.test("regrade: 多选顺序无关、部分选择判错", () => {
  const questions = [question("k1", "multiple", ["A", "B"], 0)];
  assertEquals(
    regradeAgainstSnapshot({ k1: ["B", "A"] }, questions).score,
    10000,
  );
  assertEquals(regradeAgainstSnapshot({ k1: ["A"] }, questions).score, 0);
});

Deno.test("regrade: 不修改传入的 answers 对象", () => {
  const answers = { k1: ["A"], gone: ["B"] };
  const snapshot = JSON.stringify(answers);
  regradeAgainstSnapshot(answers, [question("k1", "single", ["A"], 0)]);
  assertEquals(JSON.stringify(answers), snapshot);
});
