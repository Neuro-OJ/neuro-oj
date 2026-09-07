import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
} from "drizzle-orm/pg-core";

/**
 * LLM Provider 表。
 * 存储上游 OpenAI 兼容服务的配置；API Key 使用 NOJ_LLM_STORE_KEY 信封加密后存储。
 */
export const llmProviders = pgTable(
  "llm_providers",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    base_url: text("base_url").notNull(),
    /** 默认模型名，题目可通过 llm_config.model 覆盖 */
    model: text("model").notNull(),
    /** 每 1K token 费用（用于用量估算；0 表示不计费） */
    cost_per_1k_tokens: doublePrecision("cost_per_1k_tokens").notNull().default(
      0,
    ),
    /** AES-256-GCM 加密后的上游 API Key */
    encrypted_api_key: text("encrypted_api_key").notNull(),
    /** 是否启用；停用后新评测不能选用 */
    enabled: boolean("enabled").notNull().default(true),
    /** 创建者用户 ID（一般为 admin） */
    created_by: text("created_by").notNull().default("0"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    nameIdx: index("idx_llm_providers_name").on(table.name),
  }),
);

/**
 * LLM 调用审计表。
 * 记录每次经 gateway 转发的请求，完整保留 request_messages，不自动清理。
 */
export const llmUsage = pgTable(
  "llm_usage",
  {
    id: text("id").primaryKey(),
    submission_id: text("submission_id").notNull(),
    problem_id: text("problem_id").notNull(),
    user_id: text("user_id").notNull(),
    provider_id: text("provider_id").notNull(),
    model: text("model").notNull(),
    /** 发送给上游的完整原始 messages JSON */
    request_messages: jsonb("request_messages").notNull(),
    /** 生成参数快照（temperature/max_tokens 等） */
    request_params: jsonb("request_params").notNull().default({}),
    prompt_tokens: integer("prompt_tokens").notNull().default(0),
    completion_tokens: integer("completion_tokens").notNull().default(0),
    total_tokens: integer("total_tokens").notNull().default(0),
    /** 上游返回的缓存命中 prompt token 数 */
    cached_prompt_tokens: integer("cached_prompt_tokens").notNull().default(0),
    /** 实际计费 prompt token：prompt_tokens - cached_tokens */
    billed_prompt_tokens: integer("billed_prompt_tokens").notNull().default(0),
    /** 实际计费总 token：billed_prompt_tokens + completion_tokens */
    billed_total_tokens: integer("billed_total_tokens").notNull().default(0),
    estimated_cost: integer("estimated_cost").notNull().default(0),
    latency_ms: integer("latency_ms").notNull().default(0),
    status: text("status").notNull().default("ok"),
    error_code: text("error_code"),
    /** 请求内容哈希，用于快速去重/风控 */
    prompt_hash: text("prompt_hash").notNull(),
    created_at: text("created_at").notNull(),
  },
  (table) => ({
    submissionIdx: index("idx_llm_usage_submission_id").on(table.submission_id),
    problemIdx: index("idx_llm_usage_problem_id").on(table.problem_id),
    userIdx: index("idx_llm_usage_user_id").on(table.user_id),
    providerIdx: index("idx_llm_usage_provider_id").on(table.provider_id),
    createdIdx: index("idx_llm_usage_created_at").on(table.created_at),
  }),
);

/**
 * LLM 配额配置表。
 * 支持按用户 / 题目 / 全局维度配置日/月限额。
 */
export const llmQuotas = pgTable(
  "llm_quotas",
  {
    id: text("id").primaryKey(),
    /** 配额作用域：user / problem / global */
    scope_type: text("scope_type").notNull(),
    /** 对应作用域 ID；global 时为空字符串 */
    scope_id: text("scope_id").notNull().default(""),
    /** 窗口类型：day / month */
    window_type: text("window_type").notNull().default("day"),
    max_calls: integer("max_calls").notNull().default(0),
    max_tokens: integer("max_tokens").notNull().default(0),
    max_cost: integer("max_cost").notNull().default(0),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    scopeIdx: index("idx_llm_quotas_scope").on(
      table.scope_type,
      table.scope_id,
      table.window_type,
    ),
  }),
);
