/**
 * P3 evaluation 合同编译期负例。
 *
 * 只在正式 `check:types` / `check:contracts` 中检查，不作为运行时测试执行。
 * 直接引用生产函数：如果签名意外放宽（例如重新接受根连接、可选 actor 或缺省版本），
 * 下面的 `@ts-expect-error` 会反过来让类型检查失败。
 */
import type { DbRoot, DbTx } from "../../src/shared/db/executor.ts";
import type {
  SystemActor,
  UserActor,
} from "../../src/modules/access/contracts/actor.ts";
import { applyAttemptResultTx } from "../../src/modules/evaluations/services/versioning/tx-contracts.ts";
import {
  saveEvaluationResultTx,
} from "../../src/modules/evaluations/services/submissions/submissions-result.ts";
import { revalidateEvaluationAdmissionTx } from "../../src/modules/evaluations/contracts/admission.ts";
import { recordSseEventTx } from "../../src/modules/runtime/contracts/sse-events.ts";
import { deleteProblemEvaluationRowsTx } from "../../src/modules/evaluations/contracts/problem-deletion.ts";
import type {
  ApplyAttemptResultInput,
} from "../../src/modules/evaluations/services/versioning/result-write.ts";
import type { JudgeResult } from "../../src/modules/evaluations/types/index.ts";
import type { EvaluationAdmissionContext } from "../../src/modules/evaluations/contracts/read.ts";
import type { DomainExecutionRequest } from "../../src/modules/evaluations/services/workspace-execution.ts";

declare const root: DbRoot;
declare const tx: DbTx;
declare const user: UserActor;
declare const system: SystemActor;
declare const input: ApplyAttemptResultInput;
declare const judgeResult: JudgeResult;
declare const context: EvaluationAdmissionContext;
declare const request: DomainExecutionRequest;

function compileEvaluationContracts(): void {
  // 结果写入必须显式携带 actor 与真实事务句柄。
  void applyAttemptResultTx(tx, user, input);
  // @ts-expect-error 根连接不能冒充原子事务句柄
  void applyAttemptResultTx(root, user, input);
  // @ts-expect-error 原子 helper 不接受 undefined 执行器
  void applyAttemptResultTx(undefined, user, input);
  // @ts-expect-error 结果写入必须显式提供 actor
  void applyAttemptResultTx(tx, undefined, input);

  void saveEvaluationResultTx(tx, system, judgeResult);
  // @ts-expect-error 结果落库必须使用调用方事务
  void saveEvaluationResultTx(root, system, judgeResult);

  // 受理复核必须拿到锁内事务、快照、原始请求与版本。
  void revalidateEvaluationAdmissionTx(tx, context, request, "user", "v1");
  // @ts-expect-error 受理复核不接受根连接
  void revalidateEvaluationAdmissionTx(root, context, request, "user", "v1");
  // @ts-expect-error 受理复核必须显式给出作答版本
  void revalidateEvaluationAdmissionTx(tx, context, request, "user");

  void recordSseEventTx(tx, "channel", {});
  // @ts-expect-error SSE 事实必须与业务写入同事务
  void recordSseEventTx(root, "channel", {});

  void deleteProblemEvaluationRowsTx(tx, "problem");
  // @ts-expect-error 评测行清理不接受根连接
  void deleteProblemEvaluationRowsTx(root, "problem");
}

void compileEvaluationContracts;
