/**
 * 限流/额度检查与计数。
 *
 * 使用 Redis Lua 脚本原子完成“检查 + 自增”，避免并发下超限。
 * 支持：
 * - 单次提交 calls/tokens
 * - 用户 / 全局 / 题目 的 day / month 维度 calls / tokens / cost
 * - 用户与 IP 的分钟速率窗口
 */
import type { Db } from "./db.ts";
import type { RedisClient } from "./redis.ts";
import type { EvalTokenPayload } from "./crypto.ts";

export interface QuotaRow {
  max_calls: number;
  max_tokens: number;
  max_cost: number;
}

interface CounterSpec {
  key: string;
  limit: number;
  inc: number;
  ttl: number;
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
  return rows[0] ?? fallbackQuota(scopeType, windowType);
}

/**
 * 无配额记录时的安全 fallback。
 *
 * 默认值与 noj-core 初始化种子一致；可通过环境变量覆盖。
 * 缺失配额 MUST NOT 视为无限。
 */
function fallbackQuota(
  scopeType: string,
  windowType: string,
): QuotaRow {
  const env = Deno.env.toObject();
  const prefix =
    `NOJ_LLM_DEFAULT_${scopeType.toUpperCase()}_${windowType.toUpperCase()}`;
  const num = (key: string, fallback: number): number => {
    const raw = env[key];
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
  };

  const defaults: Record<string, QuotaRow> = {
    "global/day": { max_calls: 10000, max_tokens: 1_000_000, max_cost: 1000 },
    "global/month": {
      max_calls: 100_000,
      max_tokens: 10_000_000,
      max_cost: 10_000,
    },
    "user/day": { max_calls: 1000, max_tokens: 100_000, max_cost: 100 },
    "user/month": { max_calls: 10_000, max_tokens: 1_000_000, max_cost: 1000 },
    "problem/day": { max_calls: 5000, max_tokens: 500_000, max_cost: 500 },
    "problem/month": {
      max_calls: 50_000,
      max_tokens: 5_000_000,
      max_cost: 5000,
    },
  };
  const d = defaults[`${scopeType}/${windowType}`] ?? {
    max_calls: 1000,
    max_tokens: 100_000,
    max_cost: 100,
  };

  return {
    max_calls: num(`${prefix}_CALLS`, d.max_calls),
    max_tokens: num(`${prefix}_TOKENS`, d.max_tokens),
    max_cost: num(`${prefix}_COST`, d.max_cost),
  };
}

function dayKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function monthKey(date = new Date()): string {
  return date.toISOString().slice(0, 7);
}

function minuteKey(date = new Date()): string {
  return date.toISOString().slice(0, 16);
}

function dayEndMs(): number {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.getTime();
}

function monthEndMs(): number {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return d.getTime();
}

function scopePrefix(
  scopeType: "user" | "global" | "problem",
  scopeId: string,
): string {
  return scopeType === "global" ? "llm:global" : `llm:${scopeType}:${scopeId}`;
}

/** 构造某个作用域的 day/month 计数器（limit=0 表示不限，但仍计数）。 */
function scopeCounters(
  scopeType: "user" | "global" | "problem",
  scopeId: string,
  quota: QuotaRow | null,
  tokens: number,
  cost: number,
  now: number,
  includeCalls = true,
): CounterSpec[] {
  const prefix = scopePrefix(scopeType, scopeId);
  const maxCalls = quota?.max_calls ?? 0;
  const maxTokens = quota?.max_tokens ?? 0;
  const maxCost = quota?.max_cost ?? 0;
  const dayTtl = Math.max(1, Math.ceil((dayEndMs() - now) / 1000));
  const monthTtl = Math.max(1, Math.ceil((monthEndMs() - now) / 1000));
  const out: CounterSpec[] = [];
  if (includeCalls) {
    out.push(
      {
        key: `${prefix}:day:${dayKey()}:calls`,
        limit: maxCalls,
        inc: 1,
        ttl: dayTtl,
      },
      {
        key: `${prefix}:month:${monthKey()}:calls`,
        limit: maxCalls,
        inc: 1,
        ttl: monthTtl,
      },
    );
  }
  out.push(
    {
      key: `${prefix}:day:${dayKey()}:tokens`,
      limit: maxTokens,
      inc: tokens,
      ttl: dayTtl,
    },
    {
      key: `${prefix}:day:${dayKey()}:cost`,
      limit: maxCost,
      inc: cost,
      ttl: dayTtl,
    },
    {
      key: `${prefix}:month:${monthKey()}:tokens`,
      limit: maxTokens,
      inc: tokens,
      ttl: monthTtl,
    },
    {
      key: `${prefix}:month:${monthKey()}:cost`,
      limit: maxCost,
      inc: cost,
      ttl: monthTtl,
    },
  );
  return out;
}

const LIMIT_SCRIPT = `
local user_rate_limit = tonumber(ARGV[1])
local ip_rate_limit = tonumber(ARGV[2])
local rate_ttl = tonumber(ARGV[3])
local meta = cjson.decode(ARGV[4])
local limits = meta.limits
local incs = meta.incs
local ttls = meta.ttls

local function bump(key, amount, ttl)
  local new = redis.call('INCRBY', key, amount)
  if new == amount then
    redis.call('EXPIRE', key, ttl)
  end
  return new
end

local r1 = bump(KEYS[1], 1, rate_ttl)
if r1 > user_rate_limit then
  return 'rate_limit_exceeded'
end
local r2 = bump(KEYS[2], 1, rate_ttl)
if r2 > ip_rate_limit then
  return 'rate_limit_exceeded'
end

for i = 3, #KEYS do
  local j = i - 2
  local limit = tonumber(limits[j])
  local inc = tonumber(incs[j])
  if limit > 0 then
    local cur = tonumber(redis.call('GET', KEYS[i]) or '0')
    if cur + inc > limit then
      return 'limit_exceeded'
    end
  end
end

for i = 3, #KEYS do
  local j = i - 2
  bump(KEYS[i], tonumber(incs[j]), tonumber(ttls[j]))
end

return 'ok'
`;

const SETTLE_SCRIPT = `
local meta = cjson.decode(ARGV[1])
local limits = meta.limits
local incs = meta.incs
local ttls = meta.ttls

for i = 1, #KEYS do
  local new = redis.call('INCRBY', KEYS[i], tonumber(incs[i]))
  if new == tonumber(incs[i]) then
    redis.call('EXPIRE', KEYS[i], tonumber(ttls[i]))
  end
end

for i = 1, #KEYS do
  local limit = tonumber(limits[i])
  if limit > 0 then
    local cur = tonumber(redis.call('GET', KEYS[i]) or '0')
    if cur > limit then
      return 'limit_exceeded'
    end
  end
end

return 'ok'
`;

async function runLimitScript(
  redis: RedisClient,
  rateKeys: [string, string],
  counters: CounterSpec[],
  userRateLimit: number,
  ipRateLimit: number,
  rateTtl: number,
): Promise<string> {
  const keys = [
    rateKeys[0],
    rateKeys[1],
    ...counters.map((c) => c.key),
  ];
  const meta = {
    limits: counters.map((c) => c.limit),
    incs: counters.map((c) => c.inc),
    ttls: counters.map((c) => c.ttl),
  };
  const result = await redis.eval(LIMIT_SCRIPT, keys, [
    userRateLimit,
    ipRateLimit,
    rateTtl,
    JSON.stringify(meta),
  ]);
  return String(result ?? "ok");
}

async function runSettleScript(
  redis: RedisClient,
  counters: CounterSpec[],
): Promise<string> {
  const meta = {
    limits: counters.map((c) => c.limit),
    incs: counters.map((c) => c.inc),
    ttls: counters.map((c) => c.ttl),
  };
  const result = await redis.eval(
    SETTLE_SCRIPT,
    counters.map((c) => c.key),
    [JSON.stringify(meta)],
  );
  return String(result ?? "ok");
}

/**
 * 转发前原子检查并累加调用次数、估计 token/费用。
 * 任一限制超限时抛出错误；否则所有计数已原子自增。
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
    userRateLimitPerMinute: number;
    ipRateLimitPerMinute: number;
  },
): Promise<void> {
  const now = Date.now();
  const tokens = opts.promptTokens + opts.completionTokens;
  const cost = opts.estimatedCost;

  const userDay = await getQuota(db, "user", payload.user_id, "day");
  const userMonth = await getQuota(db, "user", payload.user_id, "month");
  const globalDay = await getQuota(db, "global", "", "day");
  const globalMonth = await getQuota(db, "global", "", "month");
  const problemDay = await getQuota(db, "problem", payload.problem_id, "day");
  const problemMonth = await getQuota(
    db,
    "problem",
    payload.problem_id,
    "month",
  );

  const counters: CounterSpec[] = [
    {
      key: `llm:sub:${payload.submission_id}:calls`,
      limit: payload.max_calls,
      inc: 1,
      ttl: opts.ttlSeconds,
    },
    {
      key: `llm:sub:${payload.submission_id}:tokens`,
      limit: payload.max_tokens,
      inc: tokens,
      ttl: opts.ttlSeconds,
    },
    {
      key: `llm:sub:${payload.submission_id}:cost`,
      limit: 0,
      inc: cost,
      ttl: opts.ttlSeconds,
    },
    ...scopeCounters("user", payload.user_id, userDay, tokens, cost, now, true),
    ...scopeCounters(
      "user",
      payload.user_id,
      userMonth,
      tokens,
      cost,
      now,
      true,
    ),
    ...scopeCounters("global", "", globalDay, tokens, cost, now, true),
    ...scopeCounters("global", "", globalMonth, tokens, cost, now, true),
    ...scopeCounters(
      "problem",
      payload.problem_id,
      problemDay,
      tokens,
      cost,
      now,
      true,
    ),
    ...scopeCounters(
      "problem",
      payload.problem_id,
      problemMonth,
      tokens,
      cost,
      now,
      true,
    ),
  ];

  const result = await runLimitScript(
    redis,
    [
      `llm:rate:${payload.user_id}:${minuteKey()}`,
      `llm:rate:ip:${opts.ip || "unknown"}:${minuteKey()}`,
    ],
    counters,
    opts.userRateLimitPerMinute,
    opts.ipRateLimitPerMinute,
    60,
  );
  if (result !== "ok") {
    throw new Error(result);
  }
}

/**
 * 上游返回后按真实 token/费用结算，并再次检查配额是否超限。
 * 如果超限抛出错误，调用方应记录 rejected 并返回 429。
 */
export async function settleUsage(
  db: Db,
  redis: RedisClient,
  payload: EvalTokenPayload,
  opts: {
    promptTokens: number;
    completionTokens: number;
    estimatedCost: number;
    actualPromptTokens: number;
    actualCompletionTokens: number;
    actualCost: number;
    ip: string;
    ttlSeconds: number;
  },
): Promise<void> {
  const now = Date.now();
  const deltaTokens = (opts.actualPromptTokens + opts.actualCompletionTokens) -
    (opts.promptTokens + opts.completionTokens);
  const deltaCost = opts.actualCost - opts.estimatedCost;

  const userDay = await getQuota(db, "user", payload.user_id, "day");
  const userMonth = await getQuota(db, "user", payload.user_id, "month");
  const globalDay = await getQuota(db, "global", "", "day");
  const globalMonth = await getQuota(db, "global", "", "month");
  const problemDay = await getQuota(db, "problem", payload.problem_id, "day");
  const problemMonth = await getQuota(
    db,
    "problem",
    payload.problem_id,
    "month",
  );

  const counters: CounterSpec[] = [
    {
      key: `llm:sub:${payload.submission_id}:tokens`,
      limit: payload.max_tokens,
      inc: deltaTokens,
      ttl: opts.ttlSeconds,
    },
    {
      key: `llm:sub:${payload.submission_id}:cost`,
      limit: 0,
      inc: deltaCost,
      ttl: opts.ttlSeconds,
    },
    ...scopeCounters(
      "user",
      payload.user_id,
      userDay,
      deltaTokens,
      deltaCost,
      now,
      false,
    ),
    ...scopeCounters(
      "user",
      payload.user_id,
      userMonth,
      deltaTokens,
      deltaCost,
      now,
      false,
    ),
    ...scopeCounters(
      "global",
      "",
      globalDay,
      deltaTokens,
      deltaCost,
      now,
      false,
    ),
    ...scopeCounters(
      "global",
      "",
      globalMonth,
      deltaTokens,
      deltaCost,
      now,
      false,
    ),
    ...scopeCounters(
      "problem",
      payload.problem_id,
      problemDay,
      deltaTokens,
      deltaCost,
      now,
      false,
    ),
    ...scopeCounters(
      "problem",
      payload.problem_id,
      problemMonth,
      deltaTokens,
      deltaCost,
      now,
      false,
    ),
  ];

  const result = await runSettleScript(redis, counters);
  if (result !== "ok") {
    throw new Error(result);
  }
}
