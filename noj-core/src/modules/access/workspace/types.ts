import { BadRequestError } from "../../../shared/base/errors.ts";
import type {
  DomainConfiguration,
  DomainPreset,
  DomainRole,
} from "../../../shared/workspace/types.ts";
import { domainTypeConfiguration } from "../../../shared/workspace/capabilities.ts";

/** 初始化域政策；类型能力由共享契约定义。 */
export function presetConfiguration(preset: DomainPreset): DomainConfiguration {
  return domainTypeConfiguration(preset);
}

// 访问策略与工作空间门面使用同一角色事实源。
export { domainPermissions } from "../types.ts";

/** 校验内置角色，拒绝平台权限或任意自定义角色。 */
export function isDomainRole(value: unknown): value is DomainRole {
  return typeof value === "string" &&
    ["owner", "admin", "editor", "educator", "moderator", "member"].includes(
      value,
    );
}
/** slug 创建后固定；不能包含题号分隔符或路径。 */
export function validateDomainSlug(value: unknown): asserts value is string {
  if (
    typeof value !== "string" || !/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/.test(value)
  ) {
    throw new BadRequestError(
      "工作空间标识须为 3–32 位小写字母、数字或连字符，且首位为字母",
    );
  }
}
/** 严格校验配置，避免将功能开关或模板名称当作权限边界。 */
export function validateDomainConfiguration(
  value: unknown,
): asserts value is DomainConfiguration {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequestError("工作空间配置非法");
  }
  const config = value as Record<string, unknown>;
  if (
    !["public", "members"].includes(String(config.access)) ||
    typeof config.discoverable !== "boolean" ||
    !["open", "approval", "invite"].includes(String(config.join_policy)) ||
    !["overview", "community", "teaching", "training"].includes(
      String(config.homepage),
    )
  ) throw new BadRequestError("工作空间访问或导航配置非法");
  const features = config.features as Record<string, unknown> | undefined;
  if (
    !features ||
    ["community", "classroom", "assignment", "analytics"].some((key) =>
      typeof features[key] !== "boolean"
    )
  ) throw new BadRequestError("工作空间功能配置非法");
  if (
    features.assignment && !features.classroom
  ) throw new BadRequestError("作业依赖班级");
}
