/** 批任务条目派发的公共类型（派发结论、源提交视图、升级上下文、租约闸门）。 */

/** 派发结论（供测试与日志使用）。 */
export type DispatchOutcome =
  | "dispatched"
  | "skipped"
  | "failed"
  | "retry"
  | "deferred";

/** 源提交（两类统一视图）。 */
export interface DispatchSource {
  domain_id?: string | null;
  domain_problem_binding_id?: string | null;
  assignment_id?: string | null;
  assignment_item_id?: string | null;
  id: string;
  problem_id: string;
  user_id: string;
  language: string;
  code: string;
  file_name: string | null;
  contest_id: string | null;
  active_attempt_id: string | null;
  artifact_storage_url: string | null;
  submitted_version_id: string | null;
  /** 客观题原始答案（升级时原样复制到新提交；重判永不改写它）。 */
  answers: Record<string, unknown> | null;
}

/** 升级上下文：`source_contest` 时新提交仍需留在原竞赛内（与受理侧同名词区分）。 */
export type JobUpgradeContext = "practice" | "source_contest";

/**
 * 派发前的租约闸门。
 *
 * 心跳到期与"真正把任务推给 Judge / 创建升级副本"之间没有原子性：若租约在此
 * 期间被其它 worker 接管，两个 worker 会各推一次评测（重复计费/重复升级）。
 * 因此在**不可回退的外部写之前**用本闸门复查一次持有状态。
 */
export interface LeaseGate {
  /** 当前仍持有条目租约；否则抛 `JOB_LEASE_LOST`。 */
  assertHeld(): Promise<void>;
}
