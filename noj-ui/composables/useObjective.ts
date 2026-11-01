/**
 * 客观题（objective）**类型与常量**。
 *
 * 0.11 删除了无域 `/api/v1/problems/:id/**` 写路径，本文件不再提供运行时 API：
 * 客观题的作答与出题都走域入口（`/domains/:slug/problems/:reference/...`），
 * 相关调用见 `useDomainProblems` / `useDomainContestAnswers`。
 */

export type ObjectiveQuestionType = 'single' | 'multiple' | 'judge';

export interface ObjectiveOption {
  key: string;
  text: string;
}

export interface ObjectiveQuestion {
  id: string;
  paper_id: string;
  sort_order: number;
  type: ObjectiveQuestionType;
  prompt: string;
  options: ObjectiveOption[];
  /** 仅 owner/admin 视图或判卷后返回 */
  answer?: (string | boolean)[];
  explanation?: string;
  created_at: string;
  updated_at: string;
  /** 写入响应附带的最新草稿 revision（继续写入时的乐观锁取值） */
  draft_revision?: number;
}

export interface ObjectivePaper {
  id: string;
  title: string;
  description: string;
  difficulty: string;
  number: number;
  /** 题目类型：U（用户题）/ P（主题题），权限随类型 */
  type: 'U' | 'P';
  /** 客观题标记（并入 problems 体系） */
  is_objective: boolean;
  owner_id: string;
  display_id: string;
  tags: { id: string; name: string; kind: 'problem' | 'algorithm' }[];
  created_at: string;
  updated_at: string;
}

/**
 * 单题判定结果。
 *
 * 竞赛模式（VULN-03）：比赛结束前后端**不返回** `correct` / `expected` / `explanation`，
 * 只返回 `given`（你的作答）；因此 `correct` 为可选，缺失即"尚无判定信息"，
 * 调用方不得把它当成 `false`（否则会把未公布渲染成"回答错误"）。
 */
export interface QuestionJudgement {
  correct?: boolean;
  expected?: (string | boolean)[];
  given: (string | boolean)[];
  explanation?: string;
}

/**
 * 客观题提交回执。
 *
 * 竞赛模式（VULN-03）在比赛结束前返回：
 * `{ score: null, score_db: null, correct_count: null, total_count: <题数>, details: {} }`，
 * 即"已提交但成绩未公布"。练习模式照旧为具体分数。
 */
export interface SubmitResult {
  submission_id: string;
  paper_id: string;
  /** 百分制分数（0–100）；竞赛进行中为 null（成绩赛后开放）。 */
  score: number | null;
  score_db: number | null;
  /** 答对题数；竞赛进行中为 null。 */
  correct_count: number | null;
  total_count: number;
  details: Record<string, QuestionJudgement>;
  contest_mode: boolean;
}

export interface ObjectiveSubmission {
  id: string;
  paper_id: string;
  user_id: string;
  contest_id: string | null;
  submission_type: 'practice' | 'contest';
  answers: Record<string, (string | boolean)[]>;
  status: string;
  /** 百分制分数；竞赛进行中为 null（历史列表同样不公布，VULN-03）。 */
  score: number | null;
  details: Record<string, QuestionJudgement>;
  created_at: string;
  // ── 版本与有效性（Handbook §4.1/§4.2：与普通提交同口径返回）──
  // 均为可选：老响应缺失时前端不渲染对应徽标（优雅降级）。
  /** 提交时版本 ID；迁移前历史提交为 null。 */
  submitted_version_id?: string | null;
  /** 提交时版本号（展示用）；未知历史版本为 null。 */
  submitted_version?: number | null;
  /** 版本来源：known / legacy_unknown。 */
  version_origin?: string;
  /** 是否为当前有效成绩（按套卷有效版本策略解析）。 */
  is_valid?: boolean;
  /** 是否为当前"通过"指针。 */
  is_accepted?: boolean;
  /** 由升级任务派生时指向源提交。 */
  upgraded_from_id?: string | null;
}

export interface ObjectiveSubmissionList {
  data: ObjectiveSubmission[];
  total: number;
  best_score: number | null;
}

export interface QuestionInput {
  type: ObjectiveQuestionType;
  prompt: string;
  options?: ObjectiveOption[];
  answer: (string | boolean)[];
  explanation?: string;
}

/** 套卷编辑器中的小题草稿（id 为 null 表示新建） */
export interface QuestionDraft {
  id: string | null;
  type: ObjectiveQuestionType;
  prompt: string;
  options: ObjectiveOption[];
  answer: (string | boolean)[];
  explanation: string;
}

/** 题型中文标签 */
export const QUESTION_TYPE_LABELS: Record<ObjectiveQuestionType, string> = {
  single: '单选',
  multiple: '多选',
  judge: '判断',
};
