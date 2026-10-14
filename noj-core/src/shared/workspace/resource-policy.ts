import type {
  DomainConfiguration,
  DomainFeatures,
  DomainLimits,
} from "./types.ts";

/** 数值限额缺省不施加新的限制；不使用负数代表不限额。 */
export function unlimitedDomainLimits(): DomainLimits {
  return {
    members: null,
    problems: null,
    storage_bytes: null,
    submissions_per_minute: null,
  };
}
/** 实例缺省允许全部域类型能力。 */
export function allowedDomainFeatures(): DomainFeatures {
  return {
    community: true,
    classroom: true,
    assignment: true,
    analytics: true,
  };
}
/** 验证完整配额对象，拒绝未知字段、负数、非整数及数据库范围溢出。 */
export function validateDomainLimits(
  value: unknown,
): asserts value is DomainLimits {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("配额须为完整对象");
  }
  const keys = Object.keys(unlimitedDomainLimits());
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).length !== keys.length ||
    Object.keys(input).some((key) => !keys.includes(key))
  ) throw new Error("配额字段不完整或包含未知字段");
  for (const key of keys) {
    const limit = input[key];
    const maximum = key === "storage_bytes"
      ? Number.MAX_SAFE_INTEGER
      : 2147483647;
    if (
      limit !== null &&
      (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 0 ||
        limit > maximum)
    ) throw new Error(`${key} 须为 null 或范围内的非负整数`);
  }
}
/** 模块列表必须完整且依赖关系有效。 */
export function validateDomainFeatures(
  value: unknown,
): asserts value is DomainFeatures {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("模块配置须为完整对象");
  }
  const input = value as Record<string, unknown>;
  const keys = Object.keys(allowedDomainFeatures());
  if (
    Object.keys(input).length !== keys.length ||
    Object.keys(input).some((key) => !keys.includes(key)) ||
    keys.some((key) => typeof input[key] !== "boolean")
  ) throw new Error("模块配置字段须为合法布尔值");
  if (
    input.assignment && !input.classroom
  ) throw new Error("作业依赖班级");
}
/** 注册表中的结构化文本同样执行业务格式验证。 */
export function validateWorkspaceSetting(
  schema: "domain_limits" | "domain_features" | "domain_llm_quota_caps",
  text: string,
) {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("工作空间配置须为合法 JSON");
  }
  if (schema === "domain_limits") validateDomainLimits(value);
  else if (schema === "domain_llm_quota_caps") {
    validateDomainLlmQuotaCaps(value);
  } else validateDomainFeatures(value);
  return value;
}

/** 实例 LLM 上限按日/月限制各项数值，单位与 Gateway 配额一致。 */
export function validateDomainLlmQuotaCaps(
  value: unknown,
): asserts value is DomainLlmQuotaCaps {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("LLM 上限须为日/月对象");
  }
  const periods = value as Record<string, unknown>;
  if (
    Object.keys(periods).length !== 2 || !("day" in periods) ||
    !("month" in periods)
  ) throw new Error("LLM 上限须包含 day 和 month");
  for (const period of [periods.day, periods.month]) {
    if (!period || typeof period !== "object" || Array.isArray(period)) {
      throw new Error("LLM 窗口上限须为对象");
    }
    const limits = period as Record<string, unknown>;
    const keys = ["max_calls", "max_tokens", "max_cost"];
    if (
      Object.keys(limits).length !== keys.length ||
      keys.some((key) => !(key in limits))
    ) throw new Error("LLM 上限字段不完整");
    for (const key of keys) {
      const limit = limits[key];
      if (
        limit !== null &&
        (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 0)
      ) throw new Error(`${key} 须为 null 或非负安全整数`);
    }
  }
}

export interface DomainLlmQuotaCaps {
  day: {
    max_calls: number | null;
    max_tokens: number | null;
    max_cost: number | null;
  };
  month: {
    max_calls: number | null;
    max_tokens: number | null;
    max_cost: number | null;
  };
}
/** 本域限额与实例上限组合；任一维度 null 不解除另一层限制。 */
export function combineDomainLimits(
  local: DomainLimits,
  caps: DomainLimits,
): DomainLimits {
  validateDomainLimits(local);
  validateDomainLimits(caps);
  const result = unlimitedDomainLimits();
  for (const key of Object.keys(result) as Array<keyof DomainLimits>) {
    result[key] = local[key] === null
      ? caps[key]
      : caps[key] === null
      ? local[key]
      : Math.min(local[key], caps[key]);
  }
  return result;
}
/** 域类型能力受实例限制；域排行不依赖教学模块。 */
export function constrainDomainConfiguration(
  configuration: DomainConfiguration,
  allowed: DomainFeatures,
): DomainConfiguration {
  const features = { ...configuration.features };
  for (const key of Object.keys(features) as Array<keyof DomainFeatures>) {
    features[key] = features[key] && allowed[key];
  }
  features.assignment = features.assignment && features.classroom;
  const homepage =
    configuration.homepage === "teaching" && !features.classroom ||
      configuration.homepage === "community" && !features.community
      ? "overview"
      : configuration.homepage;
  return { ...configuration, features, homepage };
}
