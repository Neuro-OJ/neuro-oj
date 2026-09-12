/** Neuro OJ 登录用户的最小响应字段。 */
export interface User {
  id: string;
  username: string;
  email?: string;
  must_change_password?: boolean;
}

/** IDE 题目列表所需的公开字段。 */
export interface Problem {
  id: string;
  display_id: string;
  title: string;
  difficulty: string;
  is_objective: boolean;
  submission_mode: "code" | "artifact";
}

/** 创建代码提交后的响应字段。 */
export interface CreatedSubmission {
  id: string;
  public_id?: string;
  status: SubmissionStatus;
}

export type SubmissionStatus = "pending" | "judging" | "finished" | "error";

/** 评测结果详情。分数沿用服务端协议，为放大 100 倍的整数。 */
export interface EvaluationResult {
  status: string;
  score: number;
  output: string | null;
  output_truncated: boolean | null;
  time_ms: number | null;
  memory_kb: number | null;
  details: Record<string, unknown> | null;
}

/** 提交详情响应。 */
export interface SubmissionDetail extends CreatedSubmission {
  problem_id: string;
  file_name: string;
  result: EvaluationResult | null;
  queue_position: number | null;
  queue_length: number | null;
}

/** 保存在扩展状态中的当前题目摘要。 */
export interface SelectedProblem {
  id: string;
  displayId: string;
  title: string;
}
