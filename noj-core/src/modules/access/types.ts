/** access 模块的工作空间访问策略类型与固定能力映射。 */
import { BadRequestError } from "../../shared/base/errors.ts";
import type {
  DomainConfiguration,
  DomainLimits,
  DomainPreset,
  DomainRole,
} from "../../shared/workspace/types.ts";
import { domainTypeConfiguration } from "../../shared/workspace/capabilities.ts";
import { domainRoleCapabilities } from "../../shared/access/roles.ts";

export type { DomainConfiguration, DomainLimits, DomainPreset, DomainRole };
export {
  DEFAULT_DOMAIN_ID,
  DEFAULT_DOMAIN_SLUG,
  DOMAIN_PRESETS,
} from "../../shared/workspace/types.ts";
export {
  DOMAIN_MEMBER_ROLES,
  DOMAIN_ROLES,
  type DomainMemberRole,
  isDomainMemberRole,
  isDomainRole,
  isPlatformRole,
  parseDomainMemberRole,
  parsePlatformRole,
  type PlatformRole,
} from "../../shared/access/roles.ts";

/** 有效域角色的只读能力集合；无成员关系得到空集。 */
export function domainPermissions(
  role: DomainRole | null,
): ReadonlySet<string> {
  return domainRoleCapabilities(role);
}

/** 初始化域配置；域类型能力由共享 capability 契约决定。 */
export function presetConfiguration(preset: DomainPreset): DomainConfiguration {
  return domainTypeConfiguration(preset);
}

export function validateDomainSlug(value: unknown): asserts value is string {
  if (
    typeof value !== "string" || !/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/.test(value)
  ) {
    throw new BadRequestError(
      "工作空间标识须为 3–32 位小写字母、数字或连字符，且首位为字母",
    );
  }
}

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
  if (features.assignment && !features.classroom) {
    throw new BadRequestError("作业依赖班级");
  }
}
