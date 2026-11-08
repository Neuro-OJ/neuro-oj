/** 重测任务（rejudge）的公共类型与读模型；只含类型与常量，不依赖同目录其它文件。 */

import type { EffectiveVersionPolicy } from "../../../../shared/versioning/types.ts";

/** 手动所选提交上限。 */
export const MAX_SELECTED_SUBMISSIONS = 500;
/** worker 单次领取上限（§5.7）。 */
export const MAX_JOB_ITEMS_PER_CLAIM = 100;
/**
 * 单条 `INSERT` 的条目批大小（#41）。
 *
 * 整题/整场任务没有 500 条上限，条目数可达数万；一次插入全部行会超出 PostgreSQL
 * 单语句 65535 个绑定参数的上限。所有写条目的路径统一走 `insertJobItemsBatched`。
 */
export const JOB_ITEM_INSERT_BATCH = MAX_JOB_ITEMS_PER_CLAIM;

/** 条目来源。 */
export type JobSourceKind = "submission" | "objective";

/** 重测范围。 */
export type RejudgeScope =
  | {
    type: "selected";
    submissions: Array<{ kind: JobSourceKind; id: string }>;
  }
  | { type: "problem"; problem_id: string }
  | { type: "contest"; contest_id: string };

/** 重测目标版本。 */
export type RejudgeTarget =
  | { mode: "submitted" }
  | { mode: "latest" }
  | { mode: "specified"; versions: Record<string, string> };

/** 策略变更请求。 */
export interface PolicyChangeRequest {
  problem_id: string;
  contest_id?: string;
  expected_revision: number;
  policy: EffectiveVersionPolicy;
}

/** 管理员重测请求体（§4.3）。 */
export interface RejudgeRequest {
  kind: "rejudge";
  scope: RejudgeScope;
  target: RejudgeTarget;
  policy_changes?: PolicyChangeRequest[];
}

/** 受理结果。 */
export interface AcceptJobResult {
  job_id: string;
  status: string;
  total_items: number;
  /** 已存在同幂等键任务时为 true（未新建）。 */
  existing: boolean;
}

/** 条目读模型。 */
export interface JobItemView {
  id: string;
  ordinal: number;
  source_kind: JobSourceKind;
  source_id: string;
  problem_id: string;
  target_version_id: string | null;
  target_version_ref: string | null;
  status: string;
  attempt_id: string | null;
  reason_code: string | null;
  reason_message: string | null;
}

/** 任务读模型。 */
export interface JobView {
  id: string;
  kind: string;
  actor_id: string;
  status: string;
  created_at: string;
  finished_at: string | null;
  /** 由条目聚合的计数（不维护进程内计数器）。 */
  counts: Record<string, number>;
  total_items: number;
}

/** 受理前的规范化条目。 */
export interface PlannedItem {
  source_kind: JobSourceKind;
  source_id: string;
  problem_id: string;
  target_version_id: string | null;
  target_version_ref: string | null;
  skipped_reason?: { code: string; message: string };
}
