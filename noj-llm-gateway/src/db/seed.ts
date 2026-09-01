import type { Db } from "./db.ts";

interface DefaultQuota {
  id: string;
  scope_type: "user" | "problem" | "global";
  scope_id: string;
  window_type: "day" | "month";
  max_calls: number;
  max_tokens: number;
  max_cost: number;
}

const DEFAULTS: DefaultQuota[] = [
  {
    id: "llm-quota-global-day",
    scope_type: "global",
    scope_id: "",
    window_type: "day",
    max_calls: 10000,
    max_tokens: 1_000_000,
    max_cost: 1000,
  },
  {
    id: "llm-quota-global-month",
    scope_type: "global",
    scope_id: "",
    window_type: "month",
    max_calls: 100_000,
    max_tokens: 10_000_000,
    max_cost: 10_000,
  },
  {
    id: "llm-quota-user-day",
    scope_type: "user",
    scope_id: "",
    window_type: "day",
    max_calls: 1000,
    max_tokens: 100_000,
    max_cost: 100,
  },
  {
    id: "llm-quota-problem-day",
    scope_type: "problem",
    scope_id: "",
    window_type: "day",
    max_calls: 5000,
    max_tokens: 500_000,
    max_cost: 500,
  },
];

/** 幂等写入默认 LLM 配额；已有行不覆盖。 */
export async function seedDefaultQuotas(db: Db): Promise<void> {
  const now = new Date().toISOString();
  for (const q of DEFAULTS) {
    const existing = await db`
      SELECT id FROM llm_quotas
      WHERE scope_type = ${q.scope_type}
        AND scope_id = ${q.scope_id}
        AND window_type = ${q.window_type}
      LIMIT 1
    `;
    if (existing.length > 0) continue;
    await db`
      INSERT INTO llm_quotas (
        id, scope_type, scope_id, window_type,
        max_calls, max_tokens, max_cost, created_at, updated_at
      ) VALUES (
        ${q.id}, ${q.scope_type}, ${q.scope_id}, ${q.window_type},
        ${q.max_calls}, ${q.max_tokens}, ${q.max_cost}, ${now}, ${now}
      )
    `;
    console.log(
      `[llm-gateway] 已写入默认配额: ${q.scope_type}/${q.window_type}`,
    );
  }
}
