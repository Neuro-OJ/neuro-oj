/**
 * 客观题判分核心（纯函数，无 DB 依赖，便于单元测试）。
 *
 * 判分规则：
 * - 逐题比对：给定答案与标准答案**集合精确相等**才算正确
 *   （single 单元素、judge 布尔、multiple 全选对）
 * - 卷面分：correct / total × 10000 四舍五入（×100 整数，与 SCORE_SCALE 一致）
 * - 未作答 / 未知题目 / 非法选项一律判为错误
 */
import type {
  ObjectiveAnswerValue,
  QuestionJudgement,
} from "../../../types/objective.ts";
import { SCORE_SCALE } from "../../../types/index.ts";

/** 判分输入：单道小题的判定上下文。 */
export interface QuestionToJudge {
  id: string;
  type: string;
  /** 标准答案（已按题型校验） */
  answer: ObjectiveAnswerValue[];
  /** 解析（判卷后展示） */
  explanation: string;
}

export interface JudgePaperInput {
  questions: QuestionToJudge[];
  /** 用户答案 {question_id: [选项...]} */
  answers: Record<string, ObjectiveAnswerValue[]>;
}

export interface JudgePaperOutput {
  /** ×100 整数卷面分（0-10000） */
  score: number;
  correct_count: number;
  total_count: number;
  /** 逐题判定 */
  details: Record<string, QuestionJudgement>;
}

/**
 * 归一化答案：排序并转为可比较的字符串序列（布尔 → "true"/"false"）。
 * 注意：judge 题型走严格布尔比较（见 judgeQuestion），不经此归一化。
 */
function normalizeAnswer(value: ObjectiveAnswerValue[]): string[] {
  return value.map((v) => String(v)).sort();
}

/**
 * 判定单道小题。
 * - single/multiple：选项 key 字符串集合精确相等（顺序无关）
 * - judge：严格布尔比较（[true] 与 ["true"] 不相等）
 */
export function judgeQuestion(
  question: QuestionToJudge,
  given: ObjectiveAnswerValue[] | undefined,
): QuestionJudgement {
  const expected = question.answer;
  const userGiven = given ?? [];
  let correct: boolean;
  if (question.type === "judge") {
    // 判断题：期望与给定均为单布尔值，严格类型比较
    correct = expected.length === userGiven.length &&
      expected.every((v, i) =>
        typeof v === "boolean" && typeof userGiven[i] === "boolean" &&
        v === userGiven[i]
      );
  } else {
    const expectedNorm = normalizeAnswer(expected);
    const givenNorm = normalizeAnswer(userGiven);
    correct = expectedNorm.length === givenNorm.length &&
      expectedNorm.every((v, i) => v === givenNorm[i]);
  }
  return {
    correct,
    expected: [...expected],
    given: [...userGiven],
  };
}

/**
 * 判分整张套卷。
 * 对套卷中每道小题逐一判定；用户答案中未知题目 ID 直接忽略（不参与计分）。
 */
export function judgePaper(input: JudgePaperInput): JudgePaperOutput {
  const { questions, answers } = input;
  let correctCount = 0;
  const details: Record<string, QuestionJudgement> = {};

  for (const question of questions) {
    const judgement = judgeQuestion(question, answers[question.id]);
    details[question.id] = judgement;
    if (judgement.correct) correctCount += 1;
  }

  const total = questions.length;
  // ×100 整数：correct/total × 10000 四舍五入（total 为 0 时卷面 0 分）
  const score = total === 0
    ? 0
    : Math.round((correctCount / total) * 100 * SCORE_SCALE);

  return {
    score,
    correct_count: correctCount,
    total_count: total,
    details,
  };
}
