/**
 * contests 对「竞赛 × 题目」策略行的窄事务写能力。
 *
 * `contest_problems` 由 contests 持有。评测策略切换（evaluations）只负责判定与
 * 有效成绩计算，**不能直接 UPDATE 这张表**；它必须在自己的业务事务里经由本文件
 * 提供的合同读写策略行。
 *
 * 所有函数：
 * - 第一个参数是真实 `DbTx`，不自开根事务、不读默认连接；
 * - 只写 `contest_problems` 的策略列（固定版本、模式、要求版本、revision）；
 * - revision 比较与递增在锁内完成，冲突由调用方映射为稳定 409。
 */
import { and, eq } from "drizzle-orm";
import type { DbTx } from "../../../shared/db/executor.ts";
import { contestProblems } from "../../../shared/db/schema.ts";
import type { EffectiveVersionMode } from "../../../shared/versioning/types.ts";

/** 锁内读取到的「竞赛 × 题目」策略快照。 */
export interface ContestProblemPolicySnapshot {
  /** 固定作答版本；数据库列 NOT NULL。 */
  readonly pinned_version_id: string;
  readonly mode: EffectiveVersionMode;
  readonly required_version_id: string | null;
  readonly revision: number;
}

/** 策略列的原始写入形态；由调用方按已验证的策略构造。 */
export interface ContestProblemPolicyColumns {
  readonly effective_version_mode: EffectiveVersionMode;
  readonly required_version_id: string | null;
  /** 固定作答版本；数据库列 NOT NULL，所以这里也是必填。 */
  readonly pinned_version_id: string;
}

/**
 * 锁定「竞赛 × 题目」策略行并返回快照；行不存在返回 null。
 *
 * 必须与随后的 `writeContestProblemPolicyTx` 同一事务：锁在这里取得，
 * 写入在锁内完成，中间不允许提交。
 */
export async function lockContestProblemPolicyTx(
  tx: DbTx,
  contestId: string,
  problemId: string,
): Promise<ContestProblemPolicySnapshot | null> {
  const [row] = await tx.select({
    pinned_version_id: contestProblems.pinned_version_id,
    mode: contestProblems.effective_version_mode,
    required_version_id: contestProblems.required_version_id,
    revision: contestProblems.effective_policy_revision,
  }).from(contestProblems).where(
    and(
      eq(contestProblems.contest_id, contestId),
      eq(contestProblems.problem_id, problemId),
    ),
  ).for("update");
  return row ? { ...row, mode: row.mode as EffectiveVersionMode } : null;
}

/** 只读策略快照（不加锁）；批量读取与投影计算使用。 */
export async function readContestProblemPolicyTx(
  tx: DbTx,
  contestId: string,
  problemId: string,
): Promise<ContestProblemPolicySnapshot | null> {
  const [row] = await tx.select({
    pinned_version_id: contestProblems.pinned_version_id,
    mode: contestProblems.effective_version_mode,
    required_version_id: contestProblems.required_version_id,
    revision: contestProblems.effective_policy_revision,
  }).from(contestProblems).where(
    and(
      eq(contestProblems.contest_id, contestId),
      eq(contestProblems.problem_id, problemId),
    ),
  ).limit(1);
  return row ? { ...row, mode: row.mode as EffectiveVersionMode } : null;
}

/**
 * 在已锁定的策略行上写入新策略列，并把 revision 递增 1。
 *
 * 调用方必须先用 `lockContestProblemPolicyTx` 取得行锁并完成 revision 校验；
 * 本函数不再重复比较，避免"检查与写入之间有第二个读"造成 TOCTOU。
 *
 * @returns 写入后的新 revision
 */
export async function writeContestProblemPolicyTx(
  tx: DbTx,
  contestId: string,
  problemId: string,
  columns: ContestProblemPolicyColumns,
  nextRevision: number,
): Promise<number> {
  await tx.update(contestProblems).set({
    effective_version_mode: columns.effective_version_mode,
    required_version_id: columns.required_version_id,
    pinned_version_id: columns.pinned_version_id,
    effective_policy_revision: nextRevision,
  }).where(
    and(
      eq(contestProblems.contest_id, contestId),
      eq(contestProblems.problem_id, problemId),
    ),
  );
  return nextRevision;
}
