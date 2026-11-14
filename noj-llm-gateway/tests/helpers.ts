// 路由测试共享辅助：fake Redis / fake Db / 测试配置 / fetch stub。
import type { Db } from "../src/db.ts";
import type { GatewayConfig } from "../src/config.ts";
import type { ProviderRow } from "../src/providers.ts";
import type { RedisClient } from "../src/redis.ts";
import {
  encryptSecret,
  type EvalTokenPayload,
  mintEvalToken,
} from "../src/crypto.ts";
import { createLlmRouter } from "../src/routes/llm.ts";
import { setPinnedTransport } from "../src/upstream-guard.ts";

export class FakeRedis implements RedisClient {
  serverId(): Promise<string> {
    return Promise.resolve("test-server");
  }
  evalResults: unknown[] = [];

  incr(): Promise<number> {
    return Promise.resolve(1);
  }

  incrby(): Promise<number> {
    return Promise.resolve(1);
  }

  expire(): Promise<number> {
    return Promise.resolve(1);
  }

  /** 记录被读取的键，便于断言吊销/监控键的作用域。 */
  getKeys: string[] = [];
  /** 视为已吊销的键（模拟 Redis 中的吊销标记）。 */
  revoked = new Set<string>();

  get(key?: string): Promise<string | null> {
    if (
      key === "llm:accounting:ready:v1" || key === "llm:revocations:ready:v1"
    ) {
      return Promise.resolve("test-server");
    }
    if (key) this.getKeys.push(key);
    return Promise.resolve(key && this.revoked.has(key) ? "1" : null);
  }

  ping(): Promise<string> {
    return Promise.resolve("PONG");
  }

  set(): Promise<unknown> {
    return Promise.resolve("OK");
  }

  /** 已通过 setNx 写入的键（模拟 NX 语义；TTL 不模拟）。 */
  nxKeys = new Set<string>();

  setNx(key: string): Promise<boolean> {
    if (this.nxKeys.has(key)) return Promise.resolve(false);
    this.nxKeys.add(key);
    return Promise.resolve(true);
  }

  sadd(): Promise<number> {
    return Promise.resolve(0);
  }

  scard(): Promise<number> {
    return Promise.resolve(0);
  }

  /** 记录 eval 调用传入的计数键（Lua 计数的实际作用域）。 */
  evalKeys: string[][] = [];
  evalArgs: unknown[] = [];

  eval(_script?: unknown, keys?: unknown, args?: unknown): Promise<unknown> {
    this.evalArgs.push(args);
    this.evalKeys.push(Array.isArray(keys) ? keys.map(String) : []);
    return Promise.resolve(this.evalResults.shift() ?? "ok");
  }
}

export function createFakeDb(
  provider: ProviderRow | null,
  options: {
    /** 平台调用解析的固定使用域（缺省为默认域）。 */
    domainId?: string;
    /** 平台调用解析的固定别名（缺省为 knowledge.tag 约定的 platform.tagger）。 */
    alias?: string;
    /** 平台记账插入的原始 values 收集数组（由用例断言列顺序）。 */
    platformInserts?: unknown[][];
  } = {},
): {
  db: Db;
  usageInserts: Record<string, unknown>[];
  ledger: Map<string, Record<string, unknown>>;
} {
  const { domainId, alias, platformInserts } = options;
  const fakeDbPlatformInserts = platformInserts ?? [];
  const usageInserts: Record<string, unknown>[] = [];
  const ledger = new Map<string, Record<string, unknown>>();
  const db = ((
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const sql = strings.join("?");
    if (sql.includes("INSERT INTO llm_call_ledger")) {
      ledger.set(String(values[0]), {
        id: values[0],
        domain_id: values[1],
        attempt_id: values[2],
        state: "planned",
        reservation: JSON.parse(String(values[3])),
        settlement: null,
      });
      return Promise.resolve([]);
    }
    if (sql.includes("SELECT * FROM llm_call_ledger WHERE id=")) {
      const row = ledger.get(String(values[0]));
      return Promise.resolve(row ? [row] : []);
    }
    if (sql.includes("UPDATE llm_call_ledger")) {
      if (sql.includes("state='pending'")) {
        const row = ledger.get(String(values[2]));
        if (row) {
          row.state = "pending";
          row.settlement = JSON.parse(String(values[0]));
        }
      } else if (sql.includes("state='settled'")) {
        const row = ledger.get(String(values[2]));
        if (row) {
          row.state = "settled";
          row.settlement_result = values[0];
        }
      } else if (sql.includes("state='unknown'")) {
        const row = ledger.get(String(values[1]));
        if (row) row.state = "unknown";
      } else {
        const row = ledger.get(String(values[2]));
        if (row) row.state = values[0];
      }
      return Promise.resolve([]);
    }
    // 平台调用：POST /internal/platform-usage 的聚合查询（只有 platform router 使用）。
    // 因 VALUES 模板无法被本假 DB 按列展开，平台记账行由 usageInserts 单独断言。
    if (sql.includes("UPDATE llm_usage SET status='rejected'")) {
      const row = usageInserts.find((entry) => entry.id === values[1]);
      if (row) {
        row.status = "rejected";
        row.error_code = values[0];
      }
      return Promise.resolve([]);
    }
    // 平台调用：按使用域 + 别名解析（别名始终映射到本测试 Provider）。
    // 只有解析查询（列出 provider_id/model）走这里；别名增删改仍返回空结果。
    if (sql.includes("SELECT provider_id, model")) {
      const aliased = values.includes(
        domainId ?? "00000000-0000-4000-8000-000000000001",
      ) &&
        values.includes(alias ?? "platform.tagger");
      return Promise.resolve(
        aliased && provider
          ? [{ provider_id: provider.id, model: "tag-model" }]
          : [],
      );
    }
    // 平台记账（principal_type / principal_id）：单独识别。值布局为
    // id, domain, submission, purpose, provider, model, 5 个数值, status,
    // error_code, prompt_hash, created_at, principal_type, principal_id。
    // 由用例通过 options.platformInserts 收集原始 values 自行断言。
    if (
      sql.includes("INSERT INTO llm_usage") &&
      sql.includes("principal_type") &&
      strings.some((part) => part.includes("principal_id"))
    ) {
      const values0 = values;
      fakeDbPlatformInserts.push(values0);
      // 同时登记一条按列名的聚合行。伪 Db 拿到的值布局随格式化后的跨行 VALUES
      // 变化：前 6 个数值是用量列，其后的数值里最后一个为 estimated_cost。
      const numeric = values0.filter((value) => typeof value === "number");
      const numbers = numeric.slice(0, 6);
      const estimatedCost = numeric.length > 6
        ? numeric[numeric.length - 1]
        : 0;
      usageInserts.push({
        principal_type: String(values0.at(-2) ?? "platform"),
        principal_id: String(values0.at(-1) ?? ""),
        prompt_tokens: Number(numbers[0] ?? 0),
        completion_tokens: Number(numbers[1] ?? 0),
        estimated_cost: Number(estimatedCost),
        created_at: String(values0.at(-3) ?? ""),
      });
      return Promise.resolve([]);
    }
    if (sql.includes("FROM llm_providers")) {
      return Promise.resolve(
        provider && values.includes(provider.domain_id) ? [provider] : [],
      );
    }
    if (sql.includes("FROM llm_quotas")) {
      return Promise.resolve([]);
    }
    // 平台用量聚合（GET /internal/platform-usage）：按本测试已写入的平台记账行累计。
    // 必须先于 INSERT INTO llm_usage 判断，因为该 INSERT 也包含 principal_type 列。
    if (sql.includes("principal_type='platform'")) {
      // 查询按 domain + purpose + since 过滤；测试数据均为同一域与同一 purpose，
      // 这里只按平台主体筛选（年份判断避免把无 created_at 的种子行排除）。
      const platformRows = usageInserts.filter((row) =>
        row.principal_type === "platform"
      );
      const sum = (key: string) =>
        String(
          platformRows.reduce((acc, row) => acc + Number(row[key] ?? 0), 0),
        );
      return Promise.resolve([{
        input_tokens: sum("prompt_tokens"),
        output_tokens: sum("completion_tokens"),
        requests: String(platformRows.length),
        cost: sum("estimated_cost"),
      }]);
    }
    // P5：预占在受控边界内读取实例政策行（共享锁）。测试默认"无额外上限"。
    if (sql.includes("INSERT INTO llm_policy")) {
      return Promise.resolve([]);
    }
    if (sql.includes("FROM llm_policy")) {
      return Promise.resolve([{
        revision: 0,
        day_max_calls: null,
        day_max_tokens: null,
        day_max_cost: null,
        month_max_calls: null,
        month_max_tokens: null,
        month_max_cost: null,
        updated_at: new Date(0).toISOString(),
      }]);
    }
    if (sql.includes("INSERT INTO llm_usage")) {
      const cols = [
        "id",
        "domain_id",
        "submission_id",
        "attempt_id",
        "problem_version_id",
        "problem_id",
        "user_id",
        "provider_id",
        "model",
        "request_messages",
        "request_params",
        "prompt_tokens",
        "completion_tokens",
        "total_tokens",
        "cached_prompt_tokens",
        "billed_prompt_tokens",
        "billed_total_tokens",
        "estimated_cost",
        "latency_ms",
        "status",
        "error_code",
        "prompt_hash",
        "created_at",
        "principal_type",
        "principal_id",
      ];
      const row: Record<string, unknown> = {};
      for (let i = 0; i < cols.length; i++) {
        row[cols[i]] = values[i];
      }
      usageInserts.push(row);
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  }) as unknown as Db;
  (db as unknown as { unsafe: unknown }).unsafe = () => Promise.resolve([]);
  (db as unknown as { begin: unknown }).begin = (
    operation: (tx: Db) => Promise<unknown>,
  ) => operation(db);
  (db as unknown as { reserve: unknown }).reserve = () => Promise.resolve(db);
  (db as unknown as { release: unknown }).release = () => {};
  return { db, usageInserts, ledger };
}

export async function makeProvider(storeKey: string): Promise<ProviderRow> {
  return {
    id: "prov-1",
    revision: 1,
    domain_id: "00000000-0000-4000-8000-000000000001",
    name: "test",
    base_url: "https://api.openai.com/v1",
    cost_per_1k_tokens: 1,
    encrypted_api_key: await encryptSecret("sk-test", storeKey),
    enabled: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

export const testConfig: GatewayConfig = {
  port: 8001,
  userRateLimitPerMinute: 60,
  ipRateLimitPerMinute: 60,
  serviceToken: "test-service-token-0123456789",
  storeKey: "test-store-key-0123456789",
  databaseUrl: "postgres://fake",
  redisUrl: "redis://fake",
  coreInternalUrl: "http://core.test.invalid",
  usageRetentionDays: 90,
  upstreamAllowedHosts: new Set(),
  providerQueueTimeoutMs: 60_000,
};

export async function makeToken(
  config: GatewayConfig = testConfig,
  model = "deepseek-chat",
  scope: {
    attemptId?: string;
    problemVersionId?: string;
    modelMap?: Record<string, string>;
    domainId?: string;
  } = {},
): Promise<string> {
  const payload: EvalTokenPayload = {
    jti: crypto.randomUUID(),
    domain_id: scope.domainId ?? "00000000-0000-4000-8000-000000000001",
    protocol_version: 3,
    attempt_id: scope.attemptId ?? "att-default",
    submission_id: "sub-1",
    problem_id: "prob-1",
    user_id: "user-1",
    provider_id: "prov-1",
    allowed_models: [model],
    ...(scope.modelMap ? { model_map: scope.modelMap } : {}),
    iat: Math.floor(Date.now() / 1000) - 10,
    exp: Math.floor(Date.now() / 1000) + 3600,
    max_calls: 10,
    max_tokens: 1000,
    ...(scope.attemptId
      ? {
        attempt_id: scope.attemptId,
        protocol_version: 3,
        problem_version_id: scope.problemVersionId ?? null,
      }
      : {}),
  };
  return await mintEvalToken(payload, config.serviceToken);
}

export async function requestChat(
  app: ReturnType<typeof createLlmRouter>,
  token: string,
  body: unknown,
): Promise<Response> {
  return await app.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

export function stubFetch(
  impl: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>,
): () => void {
  const original = globalThis.fetch;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).fetch = (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    if (String(input).endsWith("/api/v1/internal/llm/quota-caps")) {
      const window = { max_calls: null, max_tokens: null, max_cost: null };
      return Promise.resolve(
        new Response(JSON.stringify({ data: { day: window, month: window } }), {
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return impl(input, init);
  };
  // 上游调用自 rc/v0.11 起走固定连接传输层（审计 R1），不再是直接 `fetch`；
  // 这里把传输层一并指向替身，否则用例会打真实网络。
  setPinnedTransport((url, init) =>
    (globalThis.fetch as typeof fetch)(url, init)
  );
  return () => {
    // deno-lint-ignore no-explicit-any
    (globalThis as any).fetch = original;
    setPinnedTransport();
  };
}

/** 测试用 DNS：任何主机都解析为公网地址，避免单测依赖真实网络。 */
export function publicDns(
  _host: string,
  type: "A" | "AAAA",
): Promise<string[]> {
  return Promise.resolve(type === "A" ? ["93.184.216.34"] : []);
}
