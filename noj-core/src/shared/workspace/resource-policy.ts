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
/** 实例缺省允许域管理员按配置启用可选模块。 */
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
    input.assignment && !input.classroom || input.analytics && !input.assignment
  ) throw new Error("作业依赖班级，学情依赖作业");
}
/** 注册表中的结构化文本同样执行业务格式验证。 */
export function validateWorkspaceSetting(
  schema: "domain_limits" | "domain_features",
  text: string,
) {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("工作空间配置须为合法 JSON");
  }
  if (schema === "domain_limits") validateDomainLimits(value);
  else validateDomainFeatures(value);
  return value;
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
/** Preset 初始化只启用实例允许的功能，不覆盖存量域配置。 */
export function constrainDomainConfiguration(
  configuration: DomainConfiguration,
  allowed: DomainFeatures,
): DomainConfiguration {
  const features = { ...configuration.features };
  for (const key of Object.keys(features) as Array<keyof DomainFeatures>) {
    features[key] = features[key] && allowed[key];
  }
  features.assignment = features.assignment && features.classroom;
  features.analytics = features.analytics && features.assignment;
  const homepage =
    configuration.homepage === "teaching" && !features.classroom ||
      configuration.homepage === "community" && !features.community
      ? "overview"
      : configuration.homepage;
  return { ...configuration, features, homepage };
}
