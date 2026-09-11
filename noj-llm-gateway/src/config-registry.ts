/**
 * noj-llm-gateway 配置声明（issue #497）。
 *
 * ## 为什么网关需要自己的声明文件
 *
 * 配置的单一事实源原则是**谁读谁声明**：此前 `NOJ_LLM_DEFAULT_*` 9 个配额 env
 * 登记在 `noj-core` 的注册表里，但 noj-core 内部零读取点——真正的消费者是本网关
 * （`src/limits.ts` 的 `fallbackQuota()`）。后果是它们出现在 **noj-core** 管理后台
 * 的「环境配置」只读面板，暗示影响 core；运维改完重启 core 却毫无变化，
 * 而正确操作是重启 llm-gateway。同时网关实际支持的 month 窗口变体从未登记，
 * 既不可发现、也不在 `check:env` 覆盖范围内。
 *
 * 因此这些键迁到本文件声明，由 `noj-core/scripts/check-config-usage.ts` 校验
 * （该脚本同时读取 core 注册表与本声明，跨服务检查「声明 ↔ 读取点」一致性），
 * 并由 `tests/config_registry_test.ts` 用枚举断言锁住集合完整性。
 *
 * ## 两类读取方式
 *
 * - `static`：源码中以字面量读取（`Deno.env.get("NAME")` / `env.NAME`）。
 * - `dynamic`：由前缀模板拼接 env 名。配额键属于此类——`fallbackQuota()` 用
 *   `NOJ_LLM_DEFAULT_${SCOPE}_${WINDOW}_${FIELD}` 生成名字，普通字面量搜索查不到，
 *   这正是它们长期“隐身”的原因。声明里的 `dynamicPrefix` + `QUOTA_ENV_KEYS`
 *   枚举使其可被静态校验，且模板漂移会被测试立刻发现。
 */

import { QUOTA_ENV_KEYS } from "./limits.ts";

/** 网关配置项的声明条目 */
export interface GatewayEnvDefinition {
  /** env 变量名；dynamic 条目为模板形式的代表键 */
  key: string;
  description: string;
  /** 是否敏感（文档/日志中需脱敏） */
  isSecret: boolean;
  /** 读取方式：static 字面量 / dynamic 前缀模板 */
  readMode: "static" | "dynamic";
  /** dynamic 条目的 env 名前缀，供静态校验与枚举测试核对 */
  dynamicPrefix?: string;
  /** 默认值说明（供文档生成与人工核对） */
  defaultValue?: string;
}

/** 网关配额窗口类型（day / month，与 limits.ts 默认表一致） */
export const QUOTA_WINDOWS = ["day", "month"] as const;
/** 网关配额作用域类型 */
export const QUOTA_SCOPES = ["global", "user", "problem"] as const;
/** 网关配额字段 */
export const QUOTA_FIELDS = ["CALLS", "TOKENS", "COST"] as const;

/** 配额 env 前缀（与 limits.ts 的模板拼接保持一致） */
export const QUOTA_ENV_PREFIX = "NOJ_LLM_DEFAULT_";

/**
 * 网关配置声明。
 *
 * `NOJ_LLM_DEFAULT_*` 的 18 个具体键不再逐个列举，而是由
 * `QUOTA_SCOPES × QUOTA_WINDOWS × QUOTA_FIELDS` 生成（见 `quotaEnvDefinitions()`），
 * 避免“新增窗口忘登记”再次发生。
 */
export const GATEWAY_CONFIG_DEFINITIONS: GatewayEnvDefinition[] = [
  {
    key: "DATABASE_URL",
    description: "PostgreSQL 连接串（配额与用量表）",
    isSecret: true,
    readMode: "static",
  },
  {
    key: "REDIS_URL",
    description: "Redis 连接串（限流与额度计数）",
    isSecret: false,
    readMode: "static",
    defaultValue: "redis://127.0.0.1:6379/",
  },
  {
    key: "NOJ_LLM_SERVICE_TOKEN",
    description:
      "core↔gateway 管理 API 鉴权 + eval_token 签发/校验（≥16 字符）",
    isSecret: true,
    readMode: "static",
  },
  {
    key: "NOJ_LLM_STORE_KEY",
    description: "加密 Provider API Key 的信封加密主密钥（≥16 字符）",
    isSecret: true,
    readMode: "static",
  },
  {
    key: "NOJ_LLM_PORT",
    description: "监听端口",
    isSecret: false,
    readMode: "static",
    defaultValue: "8001",
  },
  {
    key: "NOJ_LLM_USER_RATE_LIMIT_PER_MINUTE",
    description: "每个用户每 UTC 分钟窗口允许的调用次数",
    isSecret: false,
    readMode: "static",
  },
  {
    key: "NOJ_LLM_IP_RATE_LIMIT_PER_MINUTE",
    description: "每个 IP 每 UTC 分钟窗口允许的调用次数",
    isSecret: false,
    readMode: "static",
  },
  {
    key: "NOJ_LLM_BYOK_ALLOWED_HOSTS",
    description:
      "BYOK 自带 Key 的出网主机白名单（逗号分隔）；安全相关，收紧后非白名单主机一律拒绝",
    isSecret: false,
    readMode: "static",
    defaultValue: "api.openai.com",
  },
  {
    // 代表键：真实键由前缀模板生成，枚举见 QUOTA_ENV_KEYS
    key: "NOJ_LLM_DEFAULT_<SCOPE>_<WINDOW>_<FIELD>",
    description:
      "LLM 默认配额兜底值（llm_quotas 缺行时生效）。SCOPE ∈ global|user|problem，" +
      "WINDOW ∈ day|month，FIELD ∈ CALLS|TOKENS|COST，共 18 个变量；" +
      "仅当配额表无对应记录时才作为兜底，改动需重启 llm-gateway",
    isSecret: false,
    readMode: "dynamic",
    dynamicPrefix: QUOTA_ENV_PREFIX,
  },
];

/** 生成全部 18 个配额 env 名（与 limits.ts 的模板拼接逐字一致） */
export function quotaEnvKeys(): string[] {
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
}

/**
 * 校验声明与 `limits.ts` 实际枚举出的配额键完全一致。
 *
 * 这是「模板拼接再次漂移」的护栏：`limits.ts` 一旦增删窗口/字段，
 * 这里立即失败，而不是静默地让新键不可发现。
 */
export function findQuotaEnvDrift(): {
  missing: string[];
  unexpected: string[];
} {
  const declared = new Set(quotaEnvKeys());
  const actual = new Set(QUOTA_ENV_KEYS);
  return {
    missing: [...actual].filter((k) => !declared.has(k)),
    unexpected: [...declared].filter((k) => !actual.has(k)),
  };
}
