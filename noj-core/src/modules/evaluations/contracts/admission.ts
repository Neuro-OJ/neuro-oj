/**
 * evaluations 受理事务内的最终授权复核。
 *
 * 受理链路分成两段：
 * 1. **锁外组合**（`application/evaluations.ts::composeEvaluationAdmissionContext`）：
 *    解析题目、绑定、作答版本、竞赛/作业来源与策略 revision，产出一个不可变快照；
 * 2. **锁内复核**（本文件）：在真正写入的事务里重新取得域 → 题目 → 绑定锁，重读
 *    当前事实，确认快照仍然成立。
 *
 * 为什么必须复核：锁外快照在"外部 IO（读版本、读比赛、校验上传）"期间可能失效——
 * 成员被移除、共享被撤销、绑定被下架、版本被切换、比赛窗口关闭。只用快照授权会
 * 产生"越权半受理"。因此最终授权只能来自锁内重新读到的事实。
 *
 * 固定版本冲突继续返回既有的 409 与允许公开的版本信息（`expected_version_id` /
 * `submitted_version_id`），不泄漏其他版本内容。
 */
import { AppError } from "../../../shared/base/errors.ts";
import type { DbTx } from "../../../shared/db/executor.ts";
import {
  assertEvaluationAdmission,
  type EvaluationAdmissionContext,
} from "./read.ts";
import {
  type DomainExecutionRequest,
  lockDomainExecution,
  resolveDomainExecution,
} from "../services/workspace-execution.ts";

/**
 * application 在锁外组合的一次使用域受理计划。
 *
 * `resolved` 只用于外部 IO 与任务构造；真正写入前必须由
 * `revalidateEvaluationAdmissionTx` 在调用方事务内重新取得事实。这样底层写服务
 * 不需要自行寻找 contests/education 上下文，也不会把锁外快照误当成最终授权。
 */
export type DomainEvaluationAdmissionPlan = Readonly<{
  readonly request: DomainExecutionRequest;
  readonly context: EvaluationAdmissionContext;
  readonly resolved: Awaited<ReturnType<typeof resolveDomainExecution>>;
}>;

/** 锁内复核结果：可直接写入提交/尝试行的定位事实。 */
export interface RevalidatedEvaluationAdmission {
  readonly domain_id: string;
  readonly domain_problem_binding_id: string;
  /** 作业来源（若本次受理来自作业）。 */
  readonly assignment_id: string | null;
  readonly assignment_item_id: string | null;
  /** 复核时重新读到的作答版本；必须与快照一致。 */
  readonly version_id: string;
  /** 复核时重新读到的竞赛 id；练习提交为 null。 */
  readonly contest_id: string | null;
}

/**
 * 在使用域提交的写入事务里重新授权。
 *
 * @param tx 调用方开启的唯一外层事务
 * @param context 锁外组合的受理快照
 * @param request 原始使用域请求（slug/reference/contestId/assignment）
 * @param userId 已认证用户
 * @param versionId 客户端提交的作答版本
 * @throws {AppError} 403 授权已撤销；409 版本/比赛窗口已变化
 */
export async function revalidateEvaluationAdmissionTx(
  tx: DbTx,
  context: EvaluationAdmissionContext,
  request: DomainExecutionRequest,
  userId: string,
  versionId: string,
): Promise<RevalidatedEvaluationAdmission> {
  // 先做一次解析拿到锁序所需的域/源题/绑定 ID；随后 lockDomainExecution 在
  // 同一事务里加锁并**重新解析**，因此这次读取只用于确定锁顺序，不用于授权。
  const initial = await resolveDomainExecution(request, userId, versionId, tx);
  const locked = await lockDomainExecution(
    initial,
    request,
    userId,
    versionId,
    tx,
  );

  // 锁内重读的版本必须与锁外快照一致；不一致按既有的稳定 409 语义失败。
  const current = await resolveDomainExecution(request, userId, versionId, tx);
  if (current.version.id !== context.problem.versionId) {
    throw new AppError(
      "作答版本已变化，请刷新并确认后重新提交",
      409,
      context.contest
        ? "CONTEST_PROBLEM_VERSION_CHANGED"
        : "PROBLEM_ANSWER_VERSION_CHANGED",
      {
        expected_version_id: context.problem.versionId,
        submitted_version_id: current.version.id,
      },
    );
  }
  if ((current.contestId ?? null) !== (context.contest?.contestId ?? null)) {
    throw new AppError(
      "评测受理比赛上下文已变化，请刷新后重新提交",
      409,
      "EVALUATION_ADMISSION_MISMATCH",
    );
  }

  // 用锁内事实重跑同一套准入判定：版本、固定版本、exact 策略、比赛窗口。
  assertEvaluationAdmission(context, {
    problemId: current.problem.id,
    versionId: current.version.id,
    contestId: current.contestId,
  });

  return {
    domain_id: locked.domain_id,
    domain_problem_binding_id: locked.domain_problem_binding_id,
    assignment_id: locked.assignment_id ?? null,
    assignment_item_id: locked.assignment_item_id ?? null,
    version_id: current.version.id,
    contest_id: current.contestId ?? null,
  };
}
