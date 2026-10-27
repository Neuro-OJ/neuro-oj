/** access 模块的工作空间访问策略类型与本地角色解析。 */
import { BadRequestError } from "../../shared/base/errors.ts";
import type {
  DomainConfiguration,
  DomainLimits,
  DomainPreset,
  DomainRole,
} from "../../shared/workspace/types.ts";
import { domainTypeConfiguration } from "../../shared/workspace/capabilities.ts";

export type { DomainConfiguration, DomainLimits, DomainPreset, DomainRole };
export {
  DEFAULT_DOMAIN_ID,
  DEFAULT_DOMAIN_SLUG,
  DOMAIN_PRESETS,
} from "../../shared/workspace/types.ts";

const MEMBER_PERMISSIONS = [
  "problem:read",
  "submission:create",
  "submission:read_own",
  "contest:participate",
  "training:read",
  "community:read",
  "community:create",
  "community:comment",
] as const;
const EDITOR_PERMISSIONS = [
  "problem:create",
  "problem:write_own",
  "problem:publish",
  "training:create",
  "training:import",
  "problem:import",
  "training:write_own",
  "contest:create",
  "contest:manage_own",
] as const;
const ADMIN_PERMISSIONS = [
  "domain:settings",
  "domain:members",
  "domain:invitations",
  "domain:archive",
  "problem:write_any",
  "problem:delete_any",
  "problem:share",
  "problem:policy",
  "submission:read_all",
  "submission:rejudge",
  "training:write_any",
  "training:share",
  "contest:manage",
  "classroom:manage_any",
  "llm:manage",
  "domain:limits",
  "community:moderate",
] as const;

/** 初始化域配置；域类型能力由共享 capability 契约决定。 */
export function presetConfiguration(preset: DomainPreset): DomainConfiguration {
  return domainTypeConfiguration(preset);
}

/** 只生成域内权限；平台 user_roles 不在此继承。 */
export function domainPermissions(
  roles: readonly DomainRole[],
): ReadonlySet<string> {
  const permissions = new Set<string>();
  for (const role of roles) {
    for (const permission of MEMBER_PERMISSIONS) permissions.add(permission);
    if (role === "editor" || role === "admin" || role === "owner") {
      for (const permission of EDITOR_PERMISSIONS) permissions.add(permission);
    }
    if (role === "educator" || role === "admin" || role === "owner") {
      permissions.add("classroom:create");
      permissions.add("training:import");
      permissions.add("problem:import");
      // 教练协作管理全域教学资源，不继承成员治理和敏感配置权限。
      for (const permission of EDITOR_PERMISSIONS) permissions.add(permission);
      for (
        const permission of [
          "classroom:manage_any",
          "problem:write_any",
          "problem:delete_any",
          "problem:policy",
          "training:write_any",
          "contest:manage",
        ]
      ) permissions.add(permission);
    }
    if (role === "moderator") permissions.add("community:moderate");
    if (role === "admin" || role === "owner") {
      for (const permission of ADMIN_PERMISSIONS) permissions.add(permission);
    }
    if (role === "owner") permissions.add("domain:transfer");
  }
  return permissions;
}

export function isDomainRole(value: unknown): value is DomainRole {
  return typeof value === "string" && [
    "owner",
    "admin",
    "editor",
    "educator",
    "moderator",
    "member",
  ].includes(value);
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
