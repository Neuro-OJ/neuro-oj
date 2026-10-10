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

/** 题目详情的版本元数据（`GET /problems/:id`）。 */
export interface ProblemVersionInfo {
  version_id: string | null;
  version: number | null;
  latest_version_id: string | null;
  latest_version: number | null;
  effective_version_policy: EffectiveVersionPolicy;
  is_latest: boolean;
}

/** 有效版本策略（与 core 的 `EffectiveVersionPolicy` 对齐）。 */
export type EffectiveVersionPolicy =
  | { mode: "any" }
  | { mode: "exact"; version_id: string | null };

/** 题目详情（版本元数据 + 列表字段）。 */
export interface ProblemDetail extends ProblemVersionInfo {
  id: string;
  title: string;
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
  /**
   * 选定题目时固定的**作答版本**（Handbook §4.2）。
   *
   * 提交必须携带它：新客户端不携带版本会被服务端 409 拒绝，而"静默绑定最新版"
   * 会让用户以为在评测自己看到的卷面。选择题目时读取一次，提交时原样发送；
   * 服务端返回 409 CONTEST_PROBLEM_VERSION_CHANGED 时提示刷新重选。
   */
  versionId: string | null;
  version: number | null;
}
