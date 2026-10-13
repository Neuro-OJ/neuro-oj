import { BadRequestError } from "../../shared/base/errors.ts";
import type {
  DomainConfiguration,
  DomainPreset,
  DomainRole,
} from "../../shared/workspace/types.ts";

/** 工作空间模板只在创建或显式应用时返回独立配置。 */
export function presetConfiguration(preset: DomainPreset): DomainConfiguration {
  const education = preset === "education";
  return {
    access: preset === "community" ? "public" : "members",
    discoverable: preset === "community",
    join_policy: preset === "community" ? "open" : "invite",
    features: {
      community: preset === "community",
      classroom: education,
      assignment: education,
      analytics: education,
    },
    homepage: preset === "community"
      ? "community"
      : education
      ? "teaching"
      : preset === "team"
      ? "training"
      : "overview",
  };
}

const MEMBER = [
  "problem:read",
  "submission:create",
  "submission:read_own",
  "contest:participate",
  "training:read",
  "community:read",
  "community:create",
  "community:comment",
] as const;
const EDITOR = [
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
const ADMIN = [
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

/** 仅生成域内权限；平台 user_roles 的业务权限不在此继承。 */
export function domainPermissions(
  roles: readonly DomainRole[],
): ReadonlySet<string> {
  const permissions = new Set<string>();
  for (const role of roles) {
    for (const permission of MEMBER) permissions.add(permission);
    if (role === "editor" || role === "admin" || role === "owner") {
      for (const permission of EDITOR) permissions.add(permission);
    }
    if (role === "educator" || role === "admin" || role === "owner") {
      permissions.add("classroom:create");
      permissions.add("training:import");
      permissions.add("problem:import");
    }
    if (role === "moderator") permissions.add("community:moderate");
    if (role === "admin" || role === "owner") {
      for (const permission of ADMIN) permissions.add(permission);
    }
    if (role === "owner") permissions.add("domain:transfer");
  }
  return permissions;
}

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
    features.assignment && !features.classroom ||
    features.analytics && !features.assignment
  ) throw new BadRequestError("作业依赖班级，学情依赖作业");
}
/** 可展示的模板配置差异，不执行数据删除。 */
export function configurationDiff(
  before: DomainConfiguration,
  after: DomainConfiguration,
): Array<{ key: string; before: unknown; after: unknown }> {
  validateDomainConfiguration(before);
  validateDomainConfiguration(after);
  const result: Array<{ key: string; before: unknown; after: unknown }> = [];
  for (
    const key of ["access", "discoverable", "join_policy", "homepage"] as const
  ) {
    if (before[key] !== after[key]) {
      result.push({ key, before: before[key], after: after[key] });
    }
  }
  for (
    const key of ["community", "classroom", "assignment", "analytics"] as const
  ) {
    if (before.features[key] !== after.features[key]) {
      result.push({
        key: `features.${key}`,
        before: before.features[key],
        after: after.features[key],
      });
    }
  }
  return result;
}
