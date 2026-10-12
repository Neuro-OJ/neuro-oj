import type { Db } from "../db.ts";
import { logger } from "../logger.ts";

interface DefaultQuota {
  id: string;
  scope_type: "user" | "problem" | "global" | "user_problem";
  scope_id: string;
  window_type: "day" | "month";
  max_calls: number;
  max_tokens: number;
  max_cost: number;
}

/**
 * 启动兜底配额行。
 *
 * **解析顺序**（`limits.ts` 的 `getQuota`）：`scope_id` **精确匹配**的 DB 行 →
 * `NOJ_LLM_DEFAULT_<SCOPE>_<WINDOW>_<FIELD>` env → 代码内置默认值。
 *
 * 因此这里的行只在"监管键恰好等于该 `scope_id`"时生效：
 * - `scope_type='global'`：计入键固定为 `llm:global`，与 `scope_id=""` 对应，
 *   **本表的 global 行是真正生效的**（改这里即改全局默认）。
 * - `scope_type='user' / 'problem' / 'user_problem'`：计入键分别带具体
 *   `user_id` / `problem_id` / `<userId>:<problemId>`，与 `scope_id=""` **不相等**，
 *   故这些行只是"占位记录"，**不参与限额计算**；实际默认值来自 env
 *   （24 个 `NOJ_LLM_DEFAULT_*`，由 `docker-compose.prod.yml` 显式注入）。
 *   需要为某个用户/题目/组合单独设预算时，写一条 `scope_id` 为具体 id 的行
 *   （如 `user-1:problem-1`），精确行优先于 env。
 *
 * 2026-09-25 评审修正：此前新增的 `user_problem` 占位行注释写成"任意组合的兜底"，
 * 与实现不符（不存在通配回退），会让运维以为改这行能改默认值。占位行已删除。
 */
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
    logger.info("已写入默认配额: {scope}/{window}", {
      scope: q.scope_type,
      window: q.window_type,
    });
  }
}
