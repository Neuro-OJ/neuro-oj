/**
 * 有效成绩计算——唯一纯计算入口（Handbook §3.2）。
 *
 * 调用方（题库投影 / 竞赛投影）各自读入「该作用域下某条提交的全部当前正式判定」，
 * 由本函数按策略选出有效成绩与通过成绩。函数**无副作用、无 IO、无时间依赖**，
 * 因此可以用表驱动测试穷举 Handbook §1.3 的全部状态迁移。
 */

import {
  type CurrentVersionResult,
  type EffectiveSelection,
  type EffectiveVersionPolicy,
  EMPTY_EFFECTIVE_SELECTION,
} from "./types.ts";

/** 候选是否可参与选择：必须是已完成的正式判定。 */
export function isSelectableResult(result: CurrentVersionResult): boolean {
  if (result.result_kind != null && result.result_kind !== "graded") {
    return false;
  }
  if (result.state != null && result.state !== "finished") return false;
  return true;
}

/**
 * 策略是否接受某个版本的判定。
 *
 * `any` 接受全部候选，**包括迁移的未知版本成绩**；`exact(X)` 只接受
 * `problem_version_id = X`，未知成绩不匹配。
 */
export function policyAcceptsVersion(
  policy: EffectiveVersionPolicy,
  problemVersionId: string | null,
): boolean {
  if (policy.mode === "any") return true;
  return problemVersionId != null && problemVersionId === policy.version_id;
}

/**
 * 候选稳定排序：分数降序 → sequence 升序 → attempt_id 升序。
 *
 * ID 升序只在「同分同 sequence」这一理论上不该出现的场景兜底，
 * 保证同一输入集合在任何调用点得到同一指针（避免投影抖动）。
 */
function compareCandidates(
  a: CurrentVersionResult,
  b: CurrentVersionResult,
): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.sequence !== b.sequence) return a.sequence - b.sequence;
  return a.attempt_id < b.attempt_id ? -1 : a.attempt_id > b.attempt_id ? 1 : 0;
}

/**
 * 通过成绩指针选择：通过候选中 sequence 最小（再按 ID 升序）的记录。
 *
 * 注意**不能**由最高分指针反推是否通过：有效指针可能是不通过的最高分，
 * 而通过指针可能来自分数更低的另一次尝试（Handbook §3.2 第 7 条）。
 */
function compareAcceptedCandidates(
  a: CurrentVersionResult,
  b: CurrentVersionResult,
): number {
  if (a.sequence !== b.sequence) return a.sequence - b.sequence;
  return a.attempt_id < b.attempt_id ? -1 : a.attempt_id > b.attempt_id ? 1 : 0;
}

/**
 * 对一条提交的当前正式判定集合执行有效成绩选择。
 *
 * 规则（Handbook §3.2）：
 * 1. 读入 `submission_version_results` 指向的当前正式判定；
 * 2. `any` 接受全部候选（含未知版本），`exact(X)` 只接受 X；
 * 3. 有候选则 `is_valid = true`；
 * 4. 候选中任一 `accepted` 则 `is_accepted = true`；
 * 5. 有效指针取最高分候选，同分按 sequence、ID 升序；
 * 6. 通过指针取通过候选中 sequence 最小者；
 * 7. 无候选时两个布尔为 false、两个指针为空。
 */
export function selectEffectiveResults(
  currentResults: readonly CurrentVersionResult[],
  policy: EffectiveVersionPolicy,
): EffectiveSelection {
  const candidates = currentResults.filter((result) =>
    isSelectableResult(result) &&
    policyAcceptsVersion(policy, result.problem_version_id)
  );
  if (candidates.length === 0) return { ...EMPTY_EFFECTIVE_SELECTION };

  const sorted = [...candidates].sort(compareCandidates);
  const accepted = candidates
    .filter((result) => result.accepted)
    .sort(compareAcceptedCandidates);

  return {
    is_valid: true,
    is_accepted: accepted.length > 0,
    effective_attempt_id: sorted[0].attempt_id,
    accepted_attempt_id: accepted.length > 0 ? accepted[0].attempt_id : null,
  };
}

/** 有效成绩指针指向的分数（竞赛计分用）；无候选返回 `null`。 */
export function effectiveScore(
  currentResults: readonly CurrentVersionResult[],
  policy: EffectiveVersionPolicy,
): number | null {
  const selection = selectEffectiveResults(currentResults, policy);
  if (!selection.is_valid || selection.effective_attempt_id == null) {
    return null;
  }
  const candidate = currentResults.find(
    (result) => result.attempt_id === selection.effective_attempt_id,
  );
  return candidate ? candidate.score : null;
}

/**
 * 提交级有效投影：由题库与竞赛两次选择合并而成。
 *
 * 独立作用域：题库策略与竞赛策略分别计算，互不推导。
 */
export function mergeSubmissionProjection(
  globalSelection: EffectiveSelection,
  contestSelection: EffectiveSelection,
): {
  is_valid: boolean;
  is_accepted: boolean;
  effective_attempt_id: string | null;
  accepted_attempt_id: string | null;
  is_contest_valid: boolean;
  is_contest_accepted: boolean;
  contest_effective_attempt_id: string | null;
  contest_accepted_attempt_id: string | null;
} {
  return {
    is_valid: globalSelection.is_valid,
    is_accepted: globalSelection.is_accepted,
    effective_attempt_id: globalSelection.effective_attempt_id,
    accepted_attempt_id: globalSelection.accepted_attempt_id,
    is_contest_valid: contestSelection.is_valid,
    is_contest_accepted: contestSelection.is_accepted,
    contest_effective_attempt_id: contestSelection.effective_attempt_id,
    contest_accepted_attempt_id: contestSelection.accepted_attempt_id,
  };
}
