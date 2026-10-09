/**
 * 按版本快照重判客观题（Handbook §6.4）。
 *
 * 重判的事实源是**目标版本的小题快照**，与原始 `answers` 的键按 `key` 匹配：
 * - 快照中新增的小题：用户没有对应答案 → 按未作答（计错，但仍占卷面分母）；
 * - 快照中已删除的小题：用户答案被忽略，不参与计分；
 * - 答案形式与目标题型不兼容（judge 收到字符串、single 收到布尔等）→ 按未作答；
 * - **原始 `answers` 不被改写**：重判只产出新的判定与详情。
 *
 * 纯函数、无 IO，因此可以被判卷、重判、批量重测共用。
 */

import type {
  ObjectiveAnswerValue,
  QuestionJudgement,
} from "../../types/objective.ts";
import { SCORE_SCALE } from "../../../submission/index.ts";
import type { ObjectiveQuestionSnapshot } from "../../../catalog/index.ts";

/** 单题匹配状态。 */
export type RegradeMatch =
  | "matched"
  | "missing_answer"
  | "incompatible_answer_form";

/** 重判后的单题详情（在既有判定上增加匹配状态）。 */
export interface RegradeDetail extends QuestionJudgement {
  match: RegradeMatch;
  /** 稳定机读原因码（`MISSING_ANSWER` / `INCOMPATIBLE_ANSWER_FORM`）。 */
  reason_code?: string;
}

/** 重判输出。 */
export interface RegradeOutput {
  /** ×100 整数卷面分（0-10000）。 */
  score: number;
  correct_count: number;
  total_count: number;
  matched_count: number;
  missing_count: number;
  incompatible_count: number;
  /** 快照中不存在、被忽略的用户答案键（删除的小题不计分）。 */
  ignored_keys: string[];
  details: Record<string, RegradeDetail>;
}

/** 判断用户答案形式是否被目标题型接受。 */
function isAnswerFormCompatible(
  type: ObjectiveQuestionSnapshot["type"],
  given: readonly ObjectiveAnswerValue[],
): boolean {
  if (given.length === 0) return false;
  if (type === "judge") {
    return given.length === 1 && typeof given[0] === "boolean";
  }
  return given.every((value) => typeof value === "string" && value.length > 0);
}

/** 归一化答案集合：排序后比较（与既有判分规则一致）。 */
function normalize(value: readonly ObjectiveAnswerValue[]): string[] {
  return value.map((item) => String(item)).sort();
}

/** 集合精确相等判定。 */
function answersEqual(
  type: ObjectiveQuestionSnapshot["type"],
  expected: readonly ObjectiveAnswerValue[],
  given: readonly ObjectiveAnswerValue[],
): boolean {
  if (type === "judge") {
    return expected.length === given.length &&
      expected.every((value, index) =>
        typeof value === "boolean" && typeof given[index] === "boolean" &&
        value === given[index]
      );
  }
  const left = normalize(expected);
  const right = normalize(given);
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

/**
 * 按目标版本快照重判一张卷。
 *
 * 卷面分分母是**目标版本的小题数**：新增小题会把分母变大（未作答计错），
 * 删除小题会把分母变小（旧答案不再计分）。
 */
export function regradeAgainstSnapshot(
  answers: Readonly<Record<string, ObjectiveAnswerValue[]>>,
  questions: readonly ObjectiveQuestionSnapshot[],
): RegradeOutput {
  const details: Record<string, RegradeDetail> = {};
  let correctCount = 0;
  let matchedCount = 0;
  let missingCount = 0;
  let incompatibleCount = 0;

  for (const question of questions) {
    const given = answers[question.key];
    if (given === undefined || given.length === 0) {
      details[question.key] = {
        correct: false,
        expected: [...question.answer],
        given: [],
        match: "missing_answer",
        reason_code: "MISSING_ANSWER",
      };
      missingCount += 1;
      continue;
    }
    if (!isAnswerFormCompatible(question.type, given)) {
      details[question.key] = {
        correct: false,
        expected: [...question.answer],
        given: [...given],
        match: "incompatible_answer_form",
        reason_code: "INCOMPATIBLE_ANSWER_FORM",
      };
      incompatibleCount += 1;
      continue;
    }
    const correct = answersEqual(question.type, question.answer, given);
    details[question.key] = {
      correct,
      expected: [...question.answer],
      given: [...given],
      match: "matched",
    };
    matchedCount += 1;
    if (correct) correctCount += 1;
  }

  const questionKeys = new Set(questions.map((question) => question.key));
  const ignoredKeys = Object.keys(answers).filter((key) =>
    !questionKeys.has(key)
  );

  const total = questions.length;
  return {
    score: total === 0
      ? 0
      : Math.round((correctCount / total) * 100 * SCORE_SCALE),
    correct_count: correctCount,
    total_count: total,
    matched_count: matchedCount,
    missing_count: missingCount,
    incompatible_count: incompatibleCount,
    ignored_keys: ignoredKeys,
    details,
  };
}
