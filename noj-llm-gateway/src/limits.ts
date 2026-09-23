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

/**
 * 读取某作用域的配额。
 *
 * **解析顺序**（无通配回退，评审 2026-09-25 明确）：
 * 1. `llm_quotas` 中 `(scope_type, scope_id, window_type)` **精确匹配**的行；
 * 2. `fallbackQuota()`：env `NOJ_LLM_DEFAULT_<SCOPE>_<WINDOW>_<FIELD>` → 内置默认值。
 *
 * `scope_id` 传入的是"实际计入键"的 id：`global` 为 `""`，`user` 为 `user_id`，
 * `problem` 为 `problem_id`，`user_problem` 为 `<userId>:<problemId>`。因此
 * `seed.ts` 里 `scope_id=""` 的 user/problem 行**永远不会命中本查询**，它们只是
 * 占位记录——默认值请改 env（或写一条精确 id 的行）。
 */
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

/** 配额 env 名前缀（`NOJ_LLM_DEFAULT_<SCOPE>_<WINDOW>_<FIELD>`） */
export const QUOTA_ENV_PREFIX = "NOJ_LLM_DEFAULT_";

/** 配额窗口类型（与下方 defaults 表一致） */
export const QUOTA_WINDOWS = ["day", "month"] as const;
/** 配额作用域类型 */
export const QUOTA_SCOPES = [
  "global",
  "user",
  "problem",
  "user_problem",
] as const;
/** 配额作用域联合类型 */
export type QuotaScope = typeof QUOTA_SCOPES[number];
/** 配额字段 */
export const QUOTA_FIELDS = ["CALLS", "TOKENS", "COST"] as const;

/**
 * 本模块实际读取的全部配额 env 名（共 4 scope × 2 window × 3 field = 24 个）。
 *
 * 由模板拼接生成——这也是这些键长期在「按字面量搜索」下隐身的原因。
 * 显式枚举出来，供 `src/config-registry.ts` 的声明与测试比对，
 * 使「新增窗口但忘登记」变成一次可发现的失败而非静默漂移（issue #497）。
 */
export const QUOTA_ENV_KEYS: string[] = (() => {
  const keys: string[] = [];
  for (const scope of QUOTA_SCOPES) {
    for (const window of QUOTA_WINDOWS) {
      for (const field of QUOTA_FIELDS) {
        keys.push(
          `${QUOTA_ENV_PREFIX}${scope.toUpperCase()}_${window.toUpperCase()}_${field}`,
        );
      }
    }
  }
  return keys;
})();

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
    `${QUOTA_ENV_PREFIX}${scopeType.toUpperCase()}_${windowType.toUpperCase()}`;
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
    // F-06：单用户对单题的累计预算，防止一名选手反复提交打满**全选手共享**的
    // problem 日桶，把他人 LLM 题评测冻在 0 分（关门攻击）。
    "user_problem/day": {
      max_calls: 500,
      max_tokens: 50_000,
      max_cost: 50,
    },
    "user_problem/month": {
      max_calls: 5_000,
      max_tokens: 500_000,
      max_cost: 500,
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

function dayEndMs(now: number): number {
  const d = new Date(now);
  d.setUTCHours(24, 0, 0, 0);
  return d.getTime();
}

function monthEndMs(now: number): number {
  const date = new Date(now);
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1),
  );
  return d.getTime();
}

function scopePrefix(
  scopeType: QuotaScope,
  scopeId: string,
): string {
  if (scopeType === "global") return "llm:global";
  if (scopeType === "user_problem") {
    // scopeId 形如 `<userId>:<problemId>`；用单独前缀避免与 user/problem 冲突
    return `llm:user_problem:${scopeId}`;
  }
  return `llm:${scopeType}:${scopeId}`;
}

/**
 * IP 维度分钟限流的 key 前缀（F-10）。
 *
 * 有真实客户端 IP 时按 IP 分桶；缺失（Evaluator 容器内直连、无 XFF）时
 * **不再共用 `ip:unknown` 桶**——否则所有评测流量挤在同一个 60/min 桶里，
 * 少量高吞吐提交会让他人的 LLM 评测随机 429。改按 submission 隔离，
 * 使限流只约束单个评测任务自身。
 */
export function ipRatePrefix(ip: string, submissionId: string): string {
  const trimmed = ip.trim();
  return trimmed && trimmed !== "unknown"
    ? `llm:rate:ip:${trimmed}`
    : `llm:rate:sub:${submissionId}`;
}

/** 每次只构造指定窗口的计数器，避免日/月额度混用和重复扣算。 */
function scopeCounters(
  scopeType: QuotaScope,
  scopeId: string,
  window: typeof QUOTA_WINDOWS[number],
  quota: QuotaRow | null,
  tokens: number,
  cost: number,
  now: number,
  includeCalls = true,
): CounterSpec[] {
  const date = new Date(now);
  const windowKey = window === "day" ? dayKey(date) : monthKey(date);
  const prefix = `${scopePrefix(scopeType, scopeId)}:${window}:${windowKey}`;
  const maxCalls = quota?.max_calls ?? 0;
  const maxTokens = quota?.max_tokens ?? 0;
  const maxCost = quota?.max_cost ?? 0;
  const end = window === "day" ? dayEndMs(now) : monthEndMs(now);
  const ttl = Math.max(1, Math.ceil((end - now) / 1000));
  const out: CounterSpec[] = [];
  if (includeCalls) {
    out.push(
      {
        key: `${prefix}:calls`,
        limit: maxCalls,
        inc: 1,
        ttl,
      },
    );
  }
  out.push(
    {
      key: `${prefix}:tokens`,
      limit: maxTokens,
      inc: tokens,
      ttl,
    },
    {
      key: `${prefix}:cost`,
      limit: maxCost,
      inc: cost,
      ttl,
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
  const userProblemScopeId = `${payload.user_id}:${payload.problem_id}`;
  const userProblemDay = await getQuota(
    db,
    "user_problem",
    userProblemScopeId,
    "day",
  );
  const userProblemMonth = await getQuota(
    db,
    "user_problem",
    userProblemScopeId,
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
    ...scopeCounters(
      "user",
      payload.user_id,
      "day",
      userDay,
      tokens,
      cost,
      now,
      true,
    ),
    ...scopeCounters(
      "user",
      payload.user_id,
      "month",
      userMonth,
      tokens,
      cost,
      now,
      true,
    ),
    ...scopeCounters("global", "", "day", globalDay, tokens, cost, now, true),
    ...scopeCounters(
      "global",
      "",
      "month",
      globalMonth,
      tokens,
      cost,
      now,
      true,
    ),
    ...scopeCounters(
      "problem",
      payload.problem_id,
      "day",
      problemDay,
      tokens,
      cost,
      now,
      true,
    ),
    ...scopeCounters(
      "problem",
      payload.problem_id,
      "month",
      problemMonth,
      tokens,
      cost,
      now,
      true,
    ),
    // F-06：用户×题目组合维度，防止单用户打满共享 problem 桶
    ...scopeCounters(
      "user_problem",
      userProblemScopeId,
      "day",
      userProblemDay,
      tokens,
      cost,
      now,
      true,
    ),
    ...scopeCounters(
      "user_problem",
      userProblemScopeId,
      "month",
      userProblemMonth,
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
      // F-10：Evaluator 侧不经边缘代理、无 X-Forwarded-For 时，此前全部落到
      // 共享的 `ip:unknown` 桶（默认 60/min），少量高吞吐提交即可让他人 LLM
      // 评测随机 429。无真实 IP 时改用 submission 维度隔离，避免互相挤兑。
      `${ipRatePrefix(opts.ip, payload.submission_id)}:${minuteKey()}`,
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
    actualBilledTotalTokens: number;
    actualCost: number;
    ip: string;
    ttlSeconds: number;
  },
): Promise<void> {
  const now = Date.now();
  const deltaTokens = opts.actualBilledTotalTokens -
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
  const userProblemScopeId = `${payload.user_id}:${payload.problem_id}`;
  const userProblemDay = await getQuota(
    db,
    "user_problem",
    userProblemScopeId,
    "day",
  );
  const userProblemMonth = await getQuota(
    db,
    "user_problem",
    userProblemScopeId,
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
      "day",
      userDay,
      deltaTokens,
      deltaCost,
      now,
      false,
    ),
    ...scopeCounters(
      "user",
      payload.user_id,
      "month",
      userMonth,
      deltaTokens,
      deltaCost,
      now,
      false,
    ),
    ...scopeCounters(
      "global",
      "",
      "day",
      globalDay,
      deltaTokens,
      deltaCost,
      now,
      false,
    ),
    ...scopeCounters(
      "global",
      "",
      "month",
      globalMonth,
      deltaTokens,
      deltaCost,
      now,
      false,
    ),
    ...scopeCounters(
      "problem",
      payload.problem_id,
      "day",
      problemDay,
      deltaTokens,
      deltaCost,
      now,
      false,
    ),
    ...scopeCounters(
      "problem",
      payload.problem_id,
      "month",
      problemMonth,
      deltaTokens,
      deltaCost,
      now,
      false,
    ),
    // F-06：用户×题目组合维度结算
    ...scopeCounters(
      "user_problem",
      userProblemScopeId,
      "day",
      userProblemDay,
      deltaTokens,
      deltaCost,
      now,
      false,
    ),
    ...scopeCounters(
      "user_problem",
      userProblemScopeId,
      "month",
      userProblemMonth,
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
