/** 评测吊销投影由 Core 从持久 outbox 恢复；未恢复当前 Redis 世代时拒绝新调用。 */
import type { EvalTokenPayload } from "./crypto.ts";
import type { RedisClient } from "./redis.ts";

/** Core 完成当前 Redis 世代的持久吊销重建后才写入的屏障。 */
export const TOKEN_REVOCATIONS_READY_KEY = "llm:revocations:ready:v1";

/** 与 Core 持久吊销 outbox 的尝试标识一致。 */
export function evalTokenRevokedKey(
  payload: Pick<EvalTokenPayload, "attempt_id">,
): string {
  return `llm:attempt:revoked:${payload.attempt_id}`;
}

/** 预占前身份复核失败；路由按 code 返回 401 或恢复期 503。 */
export class EvalTokenAdmissionError extends Error {
  constructor(
    readonly code:
      | "invalid_token"
      | "token_revoked"
      | "revocations_unavailable",
  ) {
    super(code);
  }
}

/** 在实际预占边界复核有效期、恢复屏障和吊销；不可只依赖进入排队前的检查。 */
export async function assertEvalTokenActive(
  redis: RedisClient,
  payload: EvalTokenPayload,
): Promise<void> {
  if (payload.exp <= Math.floor(Date.now() / 1000)) {
    throw new EvalTokenAdmissionError("invalid_token");
  }
  try {
    if (await redis.get(evalTokenRevokedKey(payload)) !== null) {
      throw new EvalTokenAdmissionError("token_revoked");
    }
    if (
      !redis.serverId ||
      await redis.get(TOKEN_REVOCATIONS_READY_KEY) !== await redis.serverId()
    ) {
      throw new EvalTokenAdmissionError("revocations_unavailable");
    }
  } catch (error) {
    if (error instanceof EvalTokenAdmissionError) throw error;
    throw new EvalTokenAdmissionError("revocations_unavailable");
  }
}
