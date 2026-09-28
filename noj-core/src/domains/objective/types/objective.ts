/**
 * 客观题类型定义：题型、小题 DTO、提交 DTO 与校验函数。
 *
 * 判分规则约定（与 specs/objective-judging 一致）：
 * - single / judge：给定答案与标准答案集合精确相等
 * - multiple：完全匹配（全对才得分）
 * - 卷面分：round(correct / total × 10000)，×100 整数存储（与 SCORE_SCALE 一致）
 */

/** 允许的小题题型。 */
export const QUESTION_TYPES = ["single", "multiple", "judge"] as const;
export type QuestionType = typeof QUESTION_TYPES[number];

/** 判断题固定选项（对/错）。 */
export const JUDGE_OPTIONS = [
  { key: "true", text: "正确" },
  { key: "false", text: "错误" },
] as const;

/** 选项结构。 */
export interface ObjectiveOption {
  key: string;
  text: string;
}

/** 标准答案：["A"] / ["A","C"] / [true]。 */
export type ObjectiveAnswerValue = string | boolean;

/** 创建小题请求体。 */
export interface CreateQuestionInput {
  /** single | multiple | judge */
  type: string;
  prompt: string;
  /** 选项数组；judge 型可省略（服务端使用固定对/错选项） */
  options?: ObjectiveOption[];
  /** 标准答案数组（judge 型为 [true]/[false]） */
  answer: ObjectiveAnswerValue[];
  /** 答案解析（判卷后展示，可选） */
  explanation?: string;
  /** 卷内排序（可选，默认追加到末尾） */
  sort_order?: number;
}

/** 更新小题请求体（全部可选，部分更新）。 */
export interface UpdateQuestionInput {
  type?: string;
  prompt?: string;
  options?: ObjectiveOption[];
  answer?: ObjectiveAnswerValue[];
  explanation?: string;
  sort_order?: number;
}

/** 小题响应（数据库行 + 派生字段）。 */
export interface ObjectiveQuestionResponse {
  id: string;
  paper_id: string;
  sort_order: number;
  type: QuestionType;
  prompt: string;
  options: ObjectiveOption[];
  /** 标准答案（仅 owner/admin 视图包含） */
  answer?: ObjectiveAnswerValue[];
  /** 答案解析（仅 owner/admin 或判卷后包含） */
  explanation?: string;
  created_at: string;
  updated_at: string;
}

/** 提交请求体。 */
export interface SubmitObjectiveInput {
  /** {question_id: [选项...]} */
  answers: Record<string, ObjectiveAnswerValue[]>;
  /** 竞赛提交时携带；练习模式省略 */
  contest_id?: string;
}

/** 单题判定结果。 */
export interface QuestionJudgement {
  /**
   * 该题是否判定正确。
   *
   * **竞赛未结束前为 `undefined`**（审计 VULN-03）：赛期返回逐题对错会让参赛者
   * 逐题试探、并联合作弊团伙把小号提交当"答案预言机"逐个排除错误选项，
   * 迅速拼凑满分答案。故赛期一律屏蔽，赛后统一结算才下发。
   */
  correct?: boolean;
  /** 期望答案（判卷后展示；竞赛模式响应不包含，防泄题） */
  expected?: ObjectiveAnswerValue[];
  /** 用户给定答案（非敏感：参赛者自己的作答） */
  given: ObjectiveAnswerValue[];
  /** 答案解析（练习模式响应/详情包含；竞赛模式不展示） */
  explanation?: string;
}

/** 练习模式提交判定结果（含逐题对错与解析）。 */
export interface SubmitObjectiveResult {
  submission_id: string;
  paper_id: string;
  score: number;
  /** ×100 整数分（与 SCORE_SCALE 一致） */
  score_db: number;
  correct_count: number;
  total_count: number;
  /** 逐题判定（练习模式含 explanation） */
  details: Record<string, QuestionJudgement>;
  /** 恒为 false（竞赛模式走 {@link SubmitObjectiveContestReceipt}） */
  contest_mode: false;
}

/**
 * 竞赛模式提交回执（审计 VULN-03）。
 *
 * 赛期**只回执"已提交"事实**，不返回分数、不返回逐题对错：
 * ```json
 * { "submission_id": "...", "status": "finished", "contest_mode": true }
 * ```
 * 竞赛结束后，参赛者可通过提交详情/历史接口看到完整分数与逐题判定
 * （赛后复盘与申诉不受影响）。
 */
export interface SubmitObjectiveContestReceipt {
  submission_id: string;
  paper_id: string;
  status: "finished";
  contest_mode: true;
  /** 赛期恒为 null；赛后由详情接口给出 */
  score: null;
  /** 赛期恒为 null；赛后由详情接口给出 */
  score_db: null;
  /** 赛期恒为 null；赛后由详情接口给出 */
  correct_count: null;
  /** 题量不敏感（套卷题面本就对参赛者可见），保留以便前端展示进度 */
  total_count: number;
  /** 赛期恒为空对象（不返回任何题目判定） */
  details: Record<string, QuestionJudgement>;
}

/** 客观题提交响应联合类型：练习模式给完整判定，竞赛模式只给回执。 */
export type SubmitObjectiveResponse =
  | SubmitObjectiveResult
  | SubmitObjectiveContestReceipt;

/** 提交记录响应。 */
export interface ObjectiveSubmissionResponse {
  id: string;
  paper_id: string;
  user_id: string;
  contest_id: string | null;
  submission_type: "practice" | "contest";
  answers: Record<string, ObjectiveAnswerValue[]>;
  status: string;
  /**
   * ×100 整数分。**竞赛未结束前为 null**（审计 VULN-03：赛期不得即时返回精确分数，
   * 否则"提交一次看分数变化"即可二分探测答案）。赛后结算恢复为数值。
   */
  score: number | null;
  details: Record<string, QuestionJudgement>;
  created_at: string;
}

/** 历史查询结果。 */
export interface ObjectiveSubmissionList {
  data: ObjectiveSubmissionResponse[];
  total: number;
  /** 练习模式最高分（×100），无提交时为 null */
  best_score: number | null;
}

/** 校验题型是否合法。 */
export function isValidQuestionType(value: string): value is QuestionType {
  return (QUESTION_TYPES as readonly string[]).includes(value);
}

/**
 * 校验标准答案数组是否符合题型约束。
 *
 * - single：恰好 1 个字符串选项
 * - multiple：1 个以上字符串选项，且不重复
 * - judge：恰好 1 个布尔值
 *
 * @throws {Error} 不合法时抛出带中文描述的 Error
 */
export function validateAnswerForType(
  type: string,
  answer: unknown,
): asserts answer is ObjectiveAnswerValue[] {
  if (!Array.isArray(answer) || answer.length === 0) {
    throw new Error("答案必须是非空数组");
  }
  if (type === "judge") {
    if (answer.length !== 1 || typeof answer[0] !== "boolean") {
      throw new Error("判断题答案必须是 [true] 或 [false]");
    }
    return;
  }
  // single / multiple：全部为字符串选项
  for (const item of answer) {
    if (typeof item !== "string" || item.length === 0) {
      throw new Error("单选/多选答案必须是选项 key 字符串数组");
    }
  }
  if (new Set(answer as string[]).size !== answer.length) {
    throw new Error("答案不能包含重复选项");
  }
  if (type === "single" && answer.length !== 1) {
    throw new Error("单选题答案必须恰好一个选项");
  }
}

/** 校验选项数组是否合法。 */
export function validateOptions(
  options: unknown,
): asserts options is ObjectiveOption[] {
  if (!Array.isArray(options)) {
    throw new Error("选项必须是数组");
  }
  const keys = new Set<string>();
  for (const item of options) {
    if (
      typeof item !== "object" || item === null ||
      typeof (item as Record<string, unknown>).key !== "string" ||
      typeof (item as Record<string, unknown>).text !== "string"
    ) {
      throw new Error("选项格式必须为 {key: string, text: string}");
    }
    const key = (item as Record<string, unknown>).key as string;
    if (key.length === 0 || keys.has(key)) {
      throw new Error("选项 key 不能为空或重复");
    }
    keys.add(key);
  }
}

/**
 * 校验提交答案载荷：对象、每个小题答案均为非空数组、键为非空字符串。
 * 具体选项合法性由判分时逐题比对（未知 question_id / 非法选项视为错误）。
 */
export function validateAnswersPayload(
  answers: unknown,
): asserts answers is Record<string, ObjectiveAnswerValue[]> {
  if (
    typeof answers !== "object" || answers === null || Array.isArray(answers)
  ) {
    throw new Error("answers 必须是 {question_id: [选项...]} 对象");
  }
  for (
    const [qid, value] of Object.entries(answers as Record<string, unknown>)
  ) {
    if (!qid) throw new Error("answers 键不能为空");
    if (!Array.isArray(value) || value.length === 0) {
      throw new Error(`题目 ${qid} 的答案必须是非空数组`);
    }
  }
}
