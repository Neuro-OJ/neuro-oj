import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * LLM Provider 表。
 * 存储上游 OpenAI 兼容服务的配置；API Key 使用 NOJ_LLM_STORE_KEY 信封加密后存储。
 */
export const llmProviders = pgTable(
  "llm_providers",
  {
    id: text("id").primaryKey(),
    domain_id: text("domain_id").notNull(),
    name: text("name").notNull(),
    base_url: text("base_url").notNull(),
    /** 每 1K token 费用（用于用量估算；0 表示不计费） */
    cost_per_1k_tokens: doublePrecision("cost_per_1k_tokens").notNull().default(
      0,
    ),
    /** AES-256-GCM 加密后的上游 API Key */
    encrypted_api_key: text("encrypted_api_key").notNull(),
    /** 是否启用；停用后新评测不能选用 */
    enabled: boolean("enabled").notNull().default(true),
    revision: integer("revision").notNull().default(1),
    /** 上游每分钟请求数上限（0 = 不限）；超过时排队等待 */
    rpm_limit: integer("rpm_limit").notNull().default(0),
    /** 上游每分钟 token 数上限（0 = 不限）；超过时排队等待 */
    tpm_limit: integer("tpm_limit").notNull().default(0),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    nameIdx: index("idx_llm_providers_name").on(table.name),
    domainIdx: index("idx_llm_providers_domain").on(table.domain_id),
    revisionCheck: check(
      "llm_providers_revision_check",
      sql`${table.revision} >= 1`,
    ),
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
    domain_id: text("domain_id").notNull(),
    submission_id: text("submission_id").notNull(),
    /** 评测尝试 ID（版本化后写入；旧记录为 NULL） */
    attempt_id: text("attempt_id"),
    /** 评测使用的题目版本（版本化后写入；旧记录为 NULL） */
    problem_version_id: text("problem_version_id"),
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
    domainCreatedIdx: index("idx_llm_usage_domain_created").on(
      table.domain_id,
      table.created_at,
    ),
    submissionIdx: index("idx_llm_usage_submission_id").on(table.submission_id),
    attemptIdx: index("idx_llm_usage_attempt_id").on(table.attempt_id),
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
    /** 实例 global 的 domain_id 为空，其他配额属于使用域。 */
    domain_id: text("domain_id").notNull().default(""),
    /** 配额作用域：domain / user / problem / global / user_problem */
    scope_type: text("scope_type").notNull(),
    /** 对应作用域 ID；global 时为空字符串 */
    scope_id: text("scope_id").notNull().default(""),
    /** 窗口类型：day / month */
    window_type: text("window_type").notNull().default("day"),
    max_calls: integer("max_calls"),
    max_tokens: integer("max_tokens"),
    max_cost: integer("max_cost"),
    revision: integer("revision").notNull().default(1),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    scopeIdx: index("idx_llm_quotas_scope").on(
      table.domain_id,
      table.scope_type,
      table.scope_id,
      table.window_type,
    ),
    revisionCheck: check(
      "llm_quotas_revision_check",
      sql`${table.revision} >= 1`,
    ),
  }),
);

/** 使用域的默认模型选择；模型权威与 Provider 权威同属 Gateway。 */
export const llmGatewayDomainSettings = pgTable(
  "llm_gateway_domain_settings",
  {
    domain_id: text("domain_id").primaryKey(),
    provider_id: text("provider_id"),
    model: text("model"),
    revision: integer("revision").notNull().default(1),
    updated_at: text("updated_at").notNull(),
    updated_by: text("updated_by").notNull(),
  },
  (table) => ({
    revisionCheck: check(
      "llm_gateway_domain_settings_revision_check",
      sql`${table.revision} >= 1`,
    ),
    selectionCheck: check(
      "llm_gateway_domain_settings_selection_check",
      sql`(${table.provider_id} IS NULL AND ${table.model} IS NULL) OR
        (${table.provider_id} IS NOT NULL AND ${table.model} IS NOT NULL
          AND length(trim(${table.provider_id})) > 0
          AND length(trim(${table.model})) > 0)`,
    ),
  }),
);

/** 使用域的模型别名；`default` 保留给 llm_gateway_domain_settings。 */
export const llmGatewayModelAliases = pgTable(
  "llm_gateway_model_aliases",
  {
    domain_id: text("domain_id").notNull(),
    alias: text("alias").notNull(),
    provider_id: text("provider_id").notNull(),
    model: text("model").notNull(),
    description: text("description").notNull().default(""),
    revision: integer("revision").notNull().default(1),
    updated_at: text("updated_at").notNull(),
    updated_by: text("updated_by").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.domain_id, table.alias] }),
    domainIdx: index("idx_llm_gateway_model_aliases_domain").on(
      table.domain_id,
    ),
    revisionCheck: check(
      "llm_gateway_model_aliases_revision_check",
      sql`${table.revision} >= 1`,
    ),
  }),
);

/** 调用预占与结算账本；Redis 计数是可对账的投影。 */
export const llmCallLedger = pgTable("llm_call_ledger", {
  id: text("id").primaryKey(),
  domain_id: text("domain_id").notNull(),
  attempt_id: text("attempt_id").notNull(),
  state: text("state").notNull(),
  reservation: jsonb("reservation").notNull(),
  settlement: jsonb("settlement"),
  settlement_result: text("settlement_result"),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
}, (table) => ({
  pendingIdx: index("idx_llm_call_ledger_state_created").on(
    table.state,
    table.created_at,
  ),
  domainIdx: index("idx_llm_call_ledger_domain_created").on(
    table.domain_id,
    table.created_at,
  ),
}));

/**
 * 实例级 LLM 配额上限政策（P5）。
 *
 * 这是 Gateway 成为政策唯一权威后的本地持久政策：`day` / `month` 的
 * `max_calls` / `max_tokens` / `max_cost`，以及乐观锁 `revision`。
 *
 * 只保留一行（`id = 'instance'`）：政策是实例级事实，不是按域配置。
 * 降额与预占的先后由本行的锁序决定：预占读取并锁定该行，政策写入也锁定同一行。
 */
export const llmPolicy = pgTable(
  "llm_policy",
  {
    /** 固定单行主键；多行说明政策被误用，迁移与运行时都会拒绝。 */
    id: text("id").primaryKey(),
    /** 当前政策 revision；0 表示从未写入，每次成功写入递增 1。 */
    revision: integer("revision").notNull().default(0),
    /** 日窗口上限。 */
    day_max_calls: integer("day_max_calls"),
    day_max_tokens: integer("day_max_tokens"),
    day_max_cost: integer("day_max_cost"),
    /** 月窗口上限。 */
    month_max_calls: integer("month_max_calls"),
    month_max_tokens: integer("month_max_tokens"),
    month_max_cost: integer("month_max_cost"),
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    /**
     * revision 允许 0：0 表示"政策从未写入，使用空政策"，与 GET 的初始返回值一致；
     * 首次成功写入从 1 开始，后续单调递增。
     */
    revisionCheck: check(
      "llm_policy_revision_check",
      sql`${table.revision} >= 0`,
    ),
    nonNegativeCheck: check(
      "llm_policy_non_negative_check",
      sql`(${table.day_max_calls} IS NULL OR ${table.day_max_calls} >= 0)
        AND (${table.day_max_tokens} IS NULL OR ${table.day_max_tokens} >= 0)
        AND (${table.day_max_cost} IS NULL OR ${table.day_max_cost} >= 0)
        AND (${table.month_max_calls} IS NULL OR ${table.month_max_calls} >= 0)
        AND (${table.month_max_tokens} IS NULL OR ${table.month_max_tokens} >= 0)
        AND (${table.month_max_cost} IS NULL OR ${table.month_max_cost} >= 0)`,
    ),
  }),
);

/**
 * 政策管理操作日志（P5）。
 *
 * 每次 `PUT /internal/policy` 都写一条：operation ID、请求摘要、预期与实际
 * revision、结果与错误码。超时后客户端可按 operation ID 查询持久结果。
 *
 * 唯一键 `operation_id` 保证「同 ID 同请求返回原结果、同 ID 不同请求拒绝」。
 */
export const llmPolicyOperations = pgTable(
  "llm_policy_operations",
  {
    /** 客户端提供的管理操作 ID（幂等键）。 */
    operation_id: text("operation_id").primaryKey(),
    /** 请求摘要（规范化后的政策 JSON 的 SHA-256）；用于识别同 ID 不同请求。 */
    request_digest: text("request_digest").notNull(),
    /** 客户端期望的 revision；与当前不一致时 409。 */
    expected_revision: integer("expected_revision").notNull(),
    /** 提交后的实际 revision（失败时保留当时读到的值）。 */
    result_revision: integer("result_revision"),
    /** `applied` / `rejected` / `conflict`。 */
    status: text("status").notNull(),
    /** 失败时的稳定错误码。 */
    error_code: text("error_code"),
    /** 结果摘要（脱敏：不含密钥，只含 revision 与窗口上限）。 */
    result: jsonb("result"),
    /** 授权管理者标识（Core 管理员 user id 或系统身份）。 */
    actor_id: text("actor_id").notNull(),
    created_at: text("created_at").notNull(),
  },
  (table) => ({
    statusCheck: check(
      "llm_policy_operations_status_check",
      sql`${table.status} IN ('applied', 'rejected', 'conflict')`,
    ),
    createdIdx: index("idx_llm_policy_operations_created").on(table.created_at),
  }),
);
