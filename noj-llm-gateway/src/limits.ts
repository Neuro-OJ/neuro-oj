/**
 * 限流/额度检查与计数。
 */
import type { Db } from "./db.ts";
import type { RedisClient } from "./redis.ts";
import { incrWithTtl, incrByWithTtl } from "./redis.ts";
import type { EvalTokenPayload } from "./crypto.ts";

export interface QuotaRow {
  max_calls: number;
  max_tokens: number;
  max_cost: number;
}

async function getQuota(
  db: Db,
  scopeType: string,
  scopeId: string,
  windowType: string,
): Promise<QuotaRow | null> {
  const rows = await db<QuotaRow[]>`
    SELECT max_calls, max_tokens, max_cost FROM llm_quotas
    WHERE scope_type = ${scopeType} AND scope_id = ${scopeId} AND window_type = ${windowType}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

function dayKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function minuteKey(date = new Date()): string {
  return date.toISOString().slice(0, 16);
}

/**
 * 检查并累加限流计数。
 * 任一限制超限时返回错误消息；否则返回本次应累加的 token/费用信息。
 */
export async function enforceAndCount(
  db: Db,
  redis: RedisClient,
  payload: EvalTokenPayload,
  opts: {
    model: string;
    promptTokens: number;
    completionTokens: number;
    estimatedCost: number;
    ip: string;
    ttlSeconds: number;
  },
): Promise<void> {
  const now = Date.now();
  const subCallsKey = `llm:sub:${payload.submission_id}:calls`;
  const subTokensKey = `llm:sub:${payload.submission_id}:tokens`;
  const userDayCallsKey = `llm:user:${payload.user_id}:day:${dayKey()}:calls`;
  const globalDayCallsKey = `llm:global:day:${dayKey()}:calls`;
  const problemDayCallsKey = `llm:problem:${payload.problem_id}:day:${dayKey()}:calls`;
  const rateKey = `llm:rate:${payload.user_id}:${minuteKey()}`;

  // 1. 单次提交调用次数 / token 上限（token 载荷内）
  const subCalls = await redis.get(subCallsKey);
  if (payload.max_calls > 0 && Number(subCalls ?? 0) >= payload.max_calls) {
    throw new Error("submission_call_limit_exceeded");
  }
  const subTokens = await redis.get(subTokensKey);
  if (payload.max_tokens > 0 && Number(subTokens ?? 0) + opts.promptTokens + opts.completionTokens > payload.max_tokens) {
    throw new Error("submission_token_limit_exceeded");
  }

  // 2. 用户日额度（DB 配置）
  const userQuota = await getQuota(db, "user", payload.user_id, "day");
  if (userQuota) {
    const used = Number(await redis.get(userDayCallsKey) ?? 0);
    if (userQuota.max_calls > 0 && used >= userQuota.max_calls) {
      throw new Error("user_daily_limit_exceeded");
    }
  }

  // 3. 全局日额度（DB 配置）
  const globalQuota = await getQuota(db, "global", "", "day");
  if (globalQuota) {
    const used = Number(await redis.get(globalDayCallsKey) ?? 0);
    if (globalQuota.max_calls > 0 && used >= globalQuota.max_calls) {
      throw new Error("global_daily_limit_exceeded");
    }
  }

  // 4. 题目日额度（DB 配置）
  const problemQuota = await getQuota(db, "problem", payload.problem_id, "day");
  if (problemQuota) {
    const used = Number(await redis.get(problemDayCallsKey) ?? 0);
    if (problemQuota.max_calls > 0 && used >= problemQuota.max_calls) {
      throw new Error("problem_daily_limit_exceeded");
    }
  }

  // 5. 用户速率窗口（每分钟 60 次，硬编码默认；后续可配置）
  const rateLimit = 60;
  const rateUsed = await incrWithTtl(redis, rateKey, 60);
  if (rateUsed > rateLimit) {
    throw new Error("rate_limit_exceeded");
  }

  // 通过后累加计数
  await Promise.all([
    incrWithTtl(redis, subCallsKey, opts.ttlSeconds),
    incrByWithTtl(redis, subTokensKey, opts.promptTokens + opts.completionTokens, opts.ttlSeconds),
    incrWithTtl(redis, userDayCallsKey, Math.ceil((dayEndMs() - now) / 1000)),
    incrWithTtl(redis, globalDayCallsKey, Math.ceil((dayEndMs() - now) / 1000)),
    incrWithTtl(redis, problemDayCallsKey, Math.ceil((dayEndMs() - now) / 1000)),
    incrByWithTtl(redis, `llm:sub:${payload.submission_id}:cost`, opts.estimatedCost, opts.ttlSeconds),
  ]);
}

function dayEndMs(): number {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.getTime();
}
