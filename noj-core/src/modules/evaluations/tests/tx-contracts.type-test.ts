import type { DbRoot, DbTx } from "../../../shared/db/executor.ts";
import { applyAttemptResultTx } from "../services/versioning/tx-contracts.ts";
import type { SystemActor, UserActor } from "../../access/index.ts";
import type { ApplyAttemptResultInput } from "../services/versioning/result-write.ts";
import {
  saveEvaluationResultTx,
} from "../services/submissions/submissions-result.ts";
import type { JudgeResult } from "../types/index.ts";
import { recordSseEventTx } from "../../runtime/index.ts";
declare const root: DbRoot;
declare const tx: DbTx;
declare const actor: UserActor;
declare const input: ApplyAttemptResultInput;
declare const systemActor: SystemActor;
declare const judgeResult: JudgeResult;
declare const channel: string;
declare const payload: Record<string, unknown>;
applyAttemptResultTx(tx, actor, input);
// @ts-expect-error root must not satisfy a transaction helper
applyAttemptResultTx(root, actor, input);
// @ts-expect-error missing transaction handle is not accepted
applyAttemptResultTx(undefined, actor, input);
recordSseEventTx(tx, channel, payload);
// @ts-expect-error runtime event persistence must use the caller's transaction
recordSseEventTx(root, channel, payload);
// @ts-expect-error missing transaction handle is not accepted
recordSseEventTx(undefined, channel, payload);
saveEvaluationResultTx(tx, systemActor, judgeResult);
// @ts-expect-error result persistence must use the caller's transaction
saveEvaluationResultTx(root, systemActor, judgeResult);
// @ts-expect-error result persistence requires an explicit SystemActor
saveEvaluationResultTx(tx, actor, judgeResult);
