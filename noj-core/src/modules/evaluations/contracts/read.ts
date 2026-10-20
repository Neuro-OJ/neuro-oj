/**
 * evaluations 对外只读合同。
 *
 * evaluations 不通过 problems/contests/education 的写服务寻找执行上下文。
 * application 在受理前组合这些不可变快照，并在调用受理命令时显式传入。这样
 * 撤销、版本切换或比赛策略变化不会被一个跨模块的隐式回查掩盖。
 */
import type {
  ProblemAccessDecision,
  ProblemVersionSnapshot,
} from "../../problems/contracts/read.ts";
import type { ContestPolicySnapshot } from "../../contests/contracts/read.ts";
import { AppError } from "../../../shared/base/errors.ts";

/** 评测来源；objective 与普通提交共享尝试/投影协议。 */
export type EvaluationSource = Readonly<{
  kind: "submission" | "objective";
  id: string;
  problemId: string;
  contestId: string | null;
}>;

/** 受理时冻结的比赛或练习执行上下文。 */
export type EvaluationAdmissionContext = Readonly<{
  problem: ProblemVersionSnapshot;
  access: ProblemAccessDecision;
  contest: ContestPolicySnapshot | null;
  assignment:
    | Readonly<{
      assignmentId: string;
      dueAt: string | null;
    }>
    | null;
}>;

/** 供 problems 删除/保留检查使用的评测引用事实。 */
export type EvaluationReference = Readonly<{
  source: EvaluationSource;
  hasActiveAttempt: boolean;
  hasHistory: boolean;
}>;

/** 结果应用后供 read-models/education 消费的事实事件。 */
export type EvaluationResultEvent = Readonly<{
  type: "evaluation.result.applied";
  source: EvaluationSource;
  attemptId: string;
  resultKind: "graded" | "platform_error";
  sequence: number;
}>;

/** 检查 application 传入的快照是否足以受理一次写入。 */
export function assertEvaluationAdmission(
  context: EvaluationAdmissionContext,
  input: {
    problemId: string;
    versionId: string;
    contestId?: string | null;
  },
): void {
  if (!context.access.allowed || !context.access.canSubmit) {
    throw new AppError(
      "评测受理上下文不允许提交",
      403,
      "EVALUATION_ADMISSION_DENIED",
    );
  }
  if (context.problem.problemId !== input.problemId) {
    throw new AppError(
      "评测受理题目与版本快照不一致",
      409,
      "EVALUATION_ADMISSION_MISMATCH",
    );
  }
  if (context.access.problemId !== input.problemId) {
    throw new AppError(
      "评测受理授权与题目快照不一致",
      409,
      "EVALUATION_ADMISSION_MISMATCH",
    );
  }
  if (context.problem.versionId !== input.versionId) {
    throw new AppError(
      "作答版本已变化，请刷新并确认后重新提交",
      409,
      context.contest
        ? "CONTEST_PROBLEM_VERSION_CHANGED"
        : "PROBLEM_ANSWER_VERSION_CHANGED",
      {
        expected_version_id: context.problem.versionId,
        submitted_version_id: input.versionId,
      },
    );
  }
  const requestedContestId = input.contestId ?? null;
  if (requestedContestId !== (context.contest?.contestId ?? null)) {
    throw new AppError(
      "评测受理比赛上下文与快照不一致",
      409,
      "EVALUATION_ADMISSION_MISMATCH",
    );
  }
  if (context.contest && context.contest.problemId !== input.problemId) {
    throw new AppError(
      "评测受理比赛题目与版本快照不一致",
      409,
      "EVALUATION_ADMISSION_MISMATCH",
    );
  }
  if (
    context.contest && context.contest.pinnedVersionId &&
    context.contest.pinnedVersionId !== input.versionId
  ) {
    throw new AppError(
      "竞赛题目版本已变更，请刷新页面后重新提交（不会自动改用其他版本）",
      409,
      "CONTEST_PROBLEM_VERSION_CHANGED",
      {
        expected_version_id: context.contest.pinnedVersionId,
        submitted_version_id: input.versionId,
      },
    );
  }
  if (
    context.contest?.effectiveVersionMode === "exact" &&
    context.contest.requiredVersionId !== input.versionId
  ) {
    throw new AppError(
      "竞赛题目有效版本策略已变更，请刷新页面后重新提交",
      409,
      "CONTEST_PROBLEM_VERSION_CHANGED",
      {
        expected_version_id: context.contest.requiredVersionId,
        submitted_version_id: input.versionId,
      },
    );
  }
  if (context.contest && !context.contest.running) {
    throw new AppError("比赛当前不在受理窗口", 409, "CONTEST_NOT_RUNNING");
  }
}

export type { ProblemAccessDecision, ProblemVersionSnapshot };
export type { ContestPolicySnapshot };
