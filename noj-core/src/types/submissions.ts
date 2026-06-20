/**
 * 提交类型定义
 */

/** 提交状态 */
export type SubmissionStatus =
  | "pending"
  | "Judging"
  | "Accepted"
  | "WrongAnswer"
  | "TimeLimitExceeded"
  | "MemoryLimitExceeded"
  | "RuntimeError"
  | "CompilationError";

/** 编程语言 */
export type Language = "python3" | "javascript" | "cpp" | "java" | "go" | "rust";

/** 提交列表项 */
export interface SubmissionSummary {
  id: string;
  problem_id: string;
  language: Language;
  status: SubmissionStatus;
  created_at: string;
}

/** 提交详情 */
export interface Submission {
  id: string;
  user_id: string;
  problem_id: string;
  language: Language;
  code: string;
  file_name: string;
  status: SubmissionStatus;
  created_at: string;
}

/** 提交创建输入 */
export interface CreateSubmissionInput {
  problem_id: string;
  language: Language;
  code: string;
  file_name?: string;
}

/** 评测结果 */
export interface EvaluationResult {
  id: string;
  submission_id: string;
  status: SubmissionStatus;
  score: number;
  output?: string;
  details?: string;
  time_ms: number;
  memory_kb: number;
}

/** 提交详情（含评测结果） */
export interface SubmissionWithResult extends Submission {
  score?: number;
  output?: string;
  details?: string;
  time_ms?: number;
  memory_kb?: number;
  judged_at?: string;
}