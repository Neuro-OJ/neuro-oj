/**
 * 客观题提交结果的展示语义（VULN-03，纯逻辑放 utils 以便单测）。
 *
 * 竞赛模式（比赛结束前）后端只返回"已提交"事实，不返回判定：
 * - 回执：`{ score: null, score_db: null, correct_count: null, total_count, details: {} }`；
 * - 历史列表：同样 `score: null`，`details` 里每题只有 `given`，**没有 `correct`**。
 *
 * 因此前端必须区分两种"没有值"：
 * 1. `correct === undefined` ⇒ 判定未公布 ⇒ **不渲染**对错徽标与红绿色
 *    （把缺失当成 `false` 会渲染"回答错误"，是把未公布说成了错误答案）；
 * 2. `score === null` ⇒ 成绩未公布 ⇒ **不渲染**分数与正确题数，改为明确文案，
 *    且不得对 null 调用 `toFixed`。
 */

/** 竞赛进行中（成绩未公布）的统一说明文案。 */
export const OBJECTIVE_PENDING_HINT = '竞赛进行中，成绩与解析将在比赛结束后开放';

/** 历史列表中单次提交成绩未公布时的占位文案。 */
export const OBJECTIVE_SCORE_PENDING_TEXT = '成绩待公布';

/** 单题判定最小形状（与 `QuestionJudgement` 结构兼容，避免 utils 依赖 composable）。 */
export interface ObjectiveJudgementLike {
  /** 缺失表示判定未公布（竞赛进行中），**不等价于 false**。 */
  correct?: boolean;
  given: (string | boolean)[];
}

/**
 * 抽出"服务端确实给出了对错"的题目。
 *
 * 返回的 Map 只包含 `correct` 为布尔值的题目；模板用 `correctness.has(qid)`
 * 判定是否渲染对错，用 `get(qid)` 取颜色/文案——缺失即不渲染。
 *
 * @param details 提交回执/历史里的逐题判定表。
 */
export function correctnessByQuestion(
  details: Record<string, ObjectiveJudgementLike> | null | undefined,
): Map<string, boolean> {
  const result = new Map<string, boolean>();
  for (const [questionId, detail] of Object.entries(details ?? {})) {
    if (typeof detail?.correct === 'boolean') result.set(questionId, detail.correct);
  }
  return result;
}

/** 提交回执的分数区展示视图。 */
export interface ObjectiveScoreView {
  /** 成绩是否尚未公布（竞赛进行中）。 */
  pending: boolean;
  /** 成绩行文案；`pending` 时为 null（调用方改用 `OBJECTIVE_PENDING_HINT`）。 */
  text: string | null;
}

/**
 * 构造提交回执的分数行。
 *
 * @param score 百分制分数；null 表示成绩未公布（竞赛进行中）。
 * @param correctCount 答对题数；未公布时为 null。
 * @param totalCount 题数。
 */
export function objectiveScoreView(
  score: number | null,
  correctCount: number | null,
  totalCount: number,
): ObjectiveScoreView {
  if (score === null) return { pending: true, text: null };
  return {
    pending: false,
    text: `本次得分：${score.toFixed(0)} 分（${correctCount ?? '—'}/${totalCount}）`,
  };
}

/**
 * 历史列表里单次提交的分数文案。
 *
 * @param score 百分制分数；null 表示成绩未公布。
 */
export function objectiveSubmissionScoreText(score: number | null): string {
  return score === null ? OBJECTIVE_SCORE_PENDING_TEXT : `${(score / 100).toFixed(0)} 分`;
}

/**
 * 历史列表里是否存在"成绩未公布"的提交（用于给出统一说明）。
 */
export function hasPendingObjectiveScore(
  submissions: readonly { score: number | null }[],
): boolean {
  return submissions.some((submission) => submission.score === null);
}
