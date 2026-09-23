import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import type { Db } from "../src/db.ts";
import type { EvalTokenPayload } from "../src/crypto.ts";
import { enforceAndCount, ipRatePrefix, settleUsage } from "../src/limits.ts";
import type { RedisClient } from "../src/redis.ts";
import { incrByWithTtl, incrWithTtl } from "../src/redis.ts";

class FakeRedis implements RedisClient {
  data = new Map<string, number>();
  expires = new Map<string, number>();
  lastEvalArgs: (string | number)[] = [];
  lastEvalKeys: string[] = [];

  async incr(key: string): Promise<number> {
    const next = (this.data.get(key) ?? 0) + 1;
    this.data.set(key, next);
    return await Promise.resolve(next);
  }

  async incrby(key: string, amount: number): Promise<number> {
    const next = (this.data.get(key) ?? 0) + amount;
    this.data.set(key, next);
    return await Promise.resolve(next);
  }

  async expire(key: string, seconds: number): Promise<number> {
    this.expires.set(key, seconds);
    return await Promise.resolve(1);
  }

  async get(key: string): Promise<string | null> {
    const value = this.data.get(key);
    return await Promise.resolve(
      value === undefined ? null : String(value),
    );
  }

  async ping(): Promise<string> {
    return await Promise.resolve("PONG");
  }

  async set(key: string, value: string): Promise<unknown> {
    this.data.set(key, Number(value));
    return await Promise.resolve("OK");
  }

  async sadd(_key: string, _member: string): Promise<number> {
    return await Promise.resolve(0);
  }

  async scard(_key: string): Promise<number> {
    return await Promise.resolve(0);
  }

  async eval(
    _script: string,
    keys: string[],
    args: (string | number)[],
  ): Promise<unknown> {
    this.lastEvalArgs = args;
    this.lastEvalKeys = keys;
    // 按 Lua 的预扣/结算语义更新状态，确保测试能发现重复计数与错误额度。
    const reserving = args.length === 4;
    const meta = JSON.parse(String(args[reserving ? 3 : 0])) as {
      limits: number[];
      incs: number[];
      ttls: number[];
    };
    const counters = reserving ? keys.slice(2) : keys;
    const exceedsLimit = () =>
      counters.some((key, i) =>
        meta.limits[i] > 0 &&
        (this.data.get(key) ?? 0) + (reserving ? meta.incs[i] : 0) >
          meta.limits[i]
      );
    if (reserving && exceedsLimit()) return "limit_exceeded";
    for (const [i, key] of counters.entries()) {
      await this.incrby(key, meta.incs[i]);
    }
    return !reserving && exceedsLimit() ? "limit_exceeded" : "ok";
  }
}

const emptyDb = ((
  _strings: TemplateStringsArray,
  ..._values: unknown[]
) => Promise.resolve([])) as unknown as Db;

const payload: EvalTokenPayload = {
  jti: "jti-1",
  submission_id: "submission-1",
  problem_id: "problem-1",
  user_id: "user-1",
  provider_id: "provider-1",
  allowed_models: ["model-1"],
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 60,
  max_calls: 10,
  max_tokens: 1000,
};

Deno.test("limits: incrWithTtl sets TTL on first increment", async () => {
  const redis = new FakeRedis();
  const first = await incrWithTtl(redis, "llm:test:count", 60);
  const second = await incrWithTtl(redis, "llm:test:count", 60);
  assertEquals(first, 1);
  assertEquals(second, 2);
  assertEquals(redis.expires.get("llm:test:count"), 60);
});

Deno.test("limits: incrByWithTtl increments and sets TTL", async () => {
  const redis = new FakeRedis();
  const value = await incrByWithTtl(redis, "llm:test:tokens", 25, 120);
  assertEquals(value, 25);
  assertEquals(redis.expires.get("llm:test:tokens"), 120);
});

Deno.test("limits: enforceAndCount passes independent minute limits", async () => {
  const redis = new FakeRedis();
  await enforceAndCount(emptyDb, redis, payload, {
    model: "model-1",
    promptTokens: 10,
    completionTokens: 5,
    estimatedCost: 1,
    ip: "127.0.0.1",
    ttlSeconds: 60,
    userRateLimitPerMinute: 120,
    ipRateLimitPerMinute: 30,
  });

  assertEquals(redis.lastEvalArgs[0], 120);
  assertEquals(redis.lastEvalArgs[1], 30);
  assertEquals(redis.lastEvalArgs[2], 60);
  const meta = JSON.parse(String(redis.lastEvalArgs[3])) as {
    limits: number[];
    incs: number[];
    ttls: number[];
  };
  assertEquals(meta.limits[0], payload.max_calls);
  assertEquals(meta.incs[0], 1);
});

Deno.test("limits: settleUsage 按 billedTotal 计算 delta", async () => {
  const redis = new FakeRedis();
  // 先 enforce 预占：估算 prompt=100, completion=50 => 预占 150
  await enforceAndCount(emptyDb, redis, { ...payload, max_tokens: 1000 }, {
    model: "model-1",
    promptTokens: 100,
    completionTokens: 50,
    estimatedCost: 1,
    ip: "127.0.0.1",
    ttlSeconds: 60,
    userRateLimitPerMinute: 120,
    ipRateLimitPerMinute: 30,
  });

  // 实际上游 billed total=30（prompt 20 未命中 + completion 10），应把 token 计数调低
  await settleUsage(emptyDb, redis, { ...payload, max_tokens: 1000 }, {
    promptTokens: 100,
    completionTokens: 50,
    estimatedCost: 1,
    actualPromptTokens: 200,
    actualCompletionTokens: 10,
    actualBilledTotalTokens: 30,
    actualCost: 0,
    ip: "127.0.0.1",
    ttlSeconds: 60,
  });

  const meta = JSON.parse(String(redis.lastEvalArgs[0])) as {
    incs: number[];
  };
  // SETTLE_SCRIPT 的 ARGV[0] 是 meta；第一个 token counter inc = -120
  assertEquals(meta.incs[0], -120);
});

const reserveOptions = {
  model: "model-1",
  promptTokens: 10,
  completionTokens: 5,
  estimatedCost: 1,
  ip: "127.0.0.1",
  ttlSeconds: 60,
  userRateLimitPerMinute: 120,
  ipRateLimitPerMinute: 30,
};

Deno.test("limits: 各作用域只预扣一次，结算后保留实际用量", async () => {
  const redis = new FakeRedis();
  await enforceAndCount(emptyDb, redis, payload, reserveOptions);
  assertEquals(new Set(redis.lastEvalKeys).size, redis.lastEvalKeys.length);
  const scopeKeys = [...redis.data.keys()].filter((key) =>
    !key.startsWith("llm:sub:")
  );
  assertEquals(scopeKeys.length, 24);
  for (const key of scopeKeys) {
    assertEquals(redis.data.get(key), key.endsWith(":tokens") ? 15 : 1, key);
  }
  await settleUsage(emptyDb, redis, payload, {
    ...reserveOptions,
    actualPromptTokens: 5,
    actualCompletionTokens: 2,
    actualBilledTotalTokens: 7,
    actualCost: 2,
  });
  assertEquals(new Set(redis.lastEvalKeys).size, redis.lastEvalKeys.length);
  for (const key of scopeKeys) {
    const expected = key.endsWith(":tokens")
      ? 7
      : key.endsWith(":cost")
      ? 2
      : 1;
    assertEquals(redis.data.get(key), expected, key);
  }
});

Deno.test("limits: 跨日后可继续使用月额度且不能超过月上限", async () => {
  // 固定 UTC 日期，避免月末或测试执行时间影响窗口边界。
  const originalNow = Date.now;
  let now = Date.UTC(2026, 8, 10, 12);
  Date.now = () => now;
  const db =
    ((_strings: TemplateStringsArray, ...values: unknown[]) =>
      Promise.resolve([{
        max_calls: values[2] === "day" ? 2 : 3,
        max_tokens: 10000,
        max_cost: 100,
      }])) as unknown as Db;
  const redis = new FakeRedis();
  try {
    await enforceAndCount(db, redis, payload, reserveOptions);
    await enforceAndCount(db, redis, payload, reserveOptions);
    await assertRejects(
      () => enforceAndCount(db, redis, payload, reserveOptions),
      Error,
      "limit_exceeded",
    );
    now += 24 * 60 * 60 * 1000;
    await enforceAndCount(db, redis, payload, reserveOptions);
    await assertRejects(
      () => enforceAndCount(db, redis, payload, reserveOptions),
      Error,
      "limit_exceeded",
    );
    for (
      const prefix of [
        "llm:user:user-1",
        "llm:global",
        "llm:problem:problem-1",
        "llm:user_problem:user-1:problem-1",
      ]
    ) {
      assertEquals(redis.data.get(`${prefix}:day:2026-09-10:calls`), 2);
      assertEquals(redis.data.get(`${prefix}:day:2026-09-11:calls`), 1);
      assertEquals(redis.data.get(`${prefix}:month:2026-09:calls`), 3);
    }
  } finally {
    Date.now = originalNow;
  }
});

Deno.test("limits: ipRatePrefix 无真实 IP 时按 submission 隔离（F-10）", () => {
  // 有真实 IP：按 IP 分桶
  assertEquals(ipRatePrefix("203.0.113.7", "sub-1"), "llm:rate:ip:203.0.113.7");
  // 缺失/占位：不再共用 unknown 桶，而是按 submission 隔离
  assertEquals(ipRatePrefix("", "sub-1"), "llm:rate:sub:sub-1");
  assertEquals(ipRatePrefix("unknown", "sub-2"), "llm:rate:sub:sub-2");
  // 不同 submission 得到不同桶，互不挤兑
  assertEquals(
    ipRatePrefix("", "sub-1") !== ipRatePrefix("", "sub-2"),
    true,
  );
});

/**
 * 构造只对满足 `match(scope_type, scope_id)` 的配额查询返回该行的假 Db。
 *
 * `getQuota` 的模板参数顺序为 `(scope_type, scope_id, window_type)`，故直接按
 * 这两个值判定即可模拟真实 DB 的精确匹配语义。
 */
function dbWithQuota(
  match: (scopeType: string, scopeId: string) => boolean,
  row: { max_calls: number; max_tokens: number; max_cost: number },
): Db {
  return ((_strings: TemplateStringsArray, ...values: unknown[]) =>
    Promise.resolve(
      match(String(values[0]), String(values[1])) ? [row] : [],
    )) as unknown as Db;
}

/** 取 PROM 计量表里 user_problem（day+month）6 个计数器的上限。 */
function userProblemLimits(redis: FakeRedis): number[] {
  const meta = JSON.parse(String(redis.lastEvalArgs[3])) as {
    limits: number[];
  };
  // 计数器顺序：sub(3) → user day/month → global day/month → problem day/month
  // → user_problem day/month（各 3 个字段），故 user_problem 位于 21..26。
  return meta.limits.slice(21, 27);
}

Deno.test("limits: user_problem 精确 scope_id 行优先于 env（F-06 解析顺序）", async () => {
  const original = Deno.env.get("NOJ_LLM_DEFAULT_USER_PROBLEM_DAY_CALLS");
  Deno.env.set("NOJ_LLM_DEFAULT_USER_PROBLEM_DAY_CALLS", "111");
  try {
    const redis = new FakeRedis();
    const db = dbWithQuota(
      (_scope, scopeId) => scopeId === "user-1:problem-1",
      { max_calls: 999, max_tokens: 12345, max_cost: 7 },
    );
    await enforceAndCount(db, redis, payload, reserveOptions);
    // 精确行命中：day/month 两个窗口的 3 个字段都取该行，env(111) 不参与
    assertEquals(userProblemLimits(redis), [999, 12345, 7, 999, 12345, 7]);
  } finally {
    if (original === undefined) {
      Deno.env.delete("NOJ_LLM_DEFAULT_USER_PROBLEM_DAY_CALLS");
    } else {
      Deno.env.set("NOJ_LLM_DEFAULT_USER_PROBLEM_DAY_CALLS", original);
    }
  }
});

Deno.test("limits: user_problem 占位行（scope_id=''）不参与限额计算（评审 2026-09-25）", async () => {
  const redis = new FakeRedis();
  // 模拟 seed.ts 曾写入的 scope_id="" 占位行：既然传入的是具体
  // `<userId>:<problemId>`，精确匹配下它永远不会命中，限额只能用内置默认值。
  const db = dbWithQuota(
    (scope, scopeId) => scope === "user_problem" && scopeId === "",
    { max_calls: 999, max_tokens: 12345, max_cost: 7 },
  );
  await enforceAndCount(db, redis, payload, reserveOptions);
  assertEquals(userProblemLimits(redis), [
    500,
    50_000,
    50,
    5_000,
    500_000,
    500,
  ]);
});

Deno.test("limits: user_problem 无精确行时由 env 提供默认值（F-06）", async () => {
  const original = Deno.env.get("NOJ_LLM_DEFAULT_USER_PROBLEM_DAY_CALLS");
  Deno.env.set("NOJ_LLM_DEFAULT_USER_PROBLEM_DAY_CALLS", "321");
  try {
    const redis = new FakeRedis();
    await enforceAndCount(emptyDb, redis, payload, reserveOptions);
    assertEquals(userProblemLimits(redis)[0], 321);
    // 未覆盖的字段仍取内置默认
    assertEquals(userProblemLimits(redis).slice(1), [
      50_000,
      50,
      5_000,
      500_000,
      500,
    ]);
  } finally {
    if (original === undefined) {
      Deno.env.delete("NOJ_LLM_DEFAULT_USER_PROBLEM_DAY_CALLS");
    } else {
      Deno.env.set("NOJ_LLM_DEFAULT_USER_PROBLEM_DAY_CALLS", original);
    }
  }
});
