/**
 * 固定角色与静态能力映射（唯一事实源）。
 *
 * 本文件回答两类问题：
 * 1. 一个账号在当前域内的有效角色是什么（负责人由 domains.owner_id 推导）。
 * 2. 该角色能做哪些事（能力集合写死在代码里，不查数据库、不读 JWT、不信客户端）。
 *
 * 数据库只持久化三类授权事实：users.role、domain_memberships.role、domains.owner_id。
 * 权限表、角色继承、自定义角色与角色数组均不再参与授权判定。
 */
import { BadRequestError } from "../base/errors.ts";

/** 平台角色：单值，仅区分普通用户与平台管理员。 */
export const PLATFORM_ROLES = ["user", "admin"] as const;
/** 平台角色类型。 */
export type PlatformRole = typeof PLATFORM_ROLES[number];

/** 域成员可持久化角色；负责人不写入成员角色列。 */
export const DOMAIN_MEMBER_ROLES = ["member", "educator", "admin"] as const;
/** 域成员可持久化角色类型。 */
export type DomainMemberRole = typeof DOMAIN_MEMBER_ROLES[number];

/** 有效域角色：负责人来自 domains.owner_id，其余来自成员记录。 */
export const DOMAIN_ROLES = ["owner", "admin", "educator", "member"] as const;
/** 有效域角色类型。 */
export type DomainRole = typeof DOMAIN_ROLES[number];

/** 判断是不是平台角色。 */
export function isPlatformRole(value: unknown): value is PlatformRole {
  return typeof value === "string" &&
    (PLATFORM_ROLES as readonly string[]).includes(value);
}

/** 判断是不是可持久化的域成员角色（含 owner 的输入不合法）。 */
export function isDomainMemberRole(
  value: unknown,
): value is DomainMemberRole {
  return typeof value === "string" &&
    (DOMAIN_MEMBER_ROLES as readonly string[]).includes(value);
}

/** 判断是不是有效域角色（含 owner）。 */
export function isDomainRole(value: unknown): value is DomainRole {
  return typeof value === "string" &&
    (DOMAIN_ROLES as readonly string[]).includes(value);
}

/**
 * 解析平台角色写入值；数组、对象、未知字符串一律 400。
 * 角色变更接口只接受单值，不接受 role_ids。
 */
export function parsePlatformRole(value: unknown): PlatformRole {
  if (!isPlatformRole(value)) {
    throw new BadRequestError("平台角色只能是 user 或 admin");
  }
  return value;
}

/**
 * 解析域成员角色写入值；owner 不能通过普通角色接口授予，数组一律 400。
 */
export function parseDomainMemberRole(value: unknown): DomainMemberRole {
  if (!isDomainMemberRole(value)) {
    throw new BadRequestError("域成员角色只能是 member、educator 或 admin");
  }
  return value;
}

/** 静态能力名；业务代码只能传这些名字。 */
export const CAPABILITIES = [
  /**
   * 平台管理员标识能力。
   *
   * 它只是“当前账号是平台管理员”的静态标记，仅授予平台 admin 角色；
   * 任何域角色（member/educator/admin/owner）都不会拥有它，因此不能把域
   * 管理员伪装成平台管理员。业务代码用它做平台级守卫（如系统设置、用户
   * 管理、角色变更），域内授权仍走域能力集合。
   */
  "admin:full_access",
  "problem:read",
  "problem:create",
  "problem:publish",
  "problem:import",
  "problem:policy",
  "problem:write_any",
  "problem:delete_any",
  "problem:field_evaluator_command",
  "problem:field_evaluator_network",
  "submission:create",
  "submission:read_own",
  "submission:read_all",
  "submission:rejudge",
  "user:read_profile",
  "user:search",
  "user:manage",
  "tag:manage",
  "contest:create",
  "contest:manage",
  "contest:manage_own",
  "contest:anti_cheat_read",
  "contest:participate",
  "community:read",
  "community:create",
  "community:create_discussion",
  "community:create_solution",
  "community:comment",
  "community:report",
  "community:moderate",
  "community_moderation:review",
  "community_moderation:hide",
  "community_moderation:lock",
  "community_moderation:sanction",
  "community_board:manage",
  "training:create",
  "training:read",
  "training:read_any",
  "training:write_any",
  "training:delete_any",
  "training:publish",
  "training:pin",
  "training:import",
  "announcement:manage",
  "legal:manage",
  "system:settings",
  "system:judge_images",
  "system:audit_logs",
  "system:ip_bans",
  "classroom:create",
  "classroom:manage_any",
  "llm:manage",
  "domain:settings",
  "domain:members",
  "domain:invitations",
  "domain:archive",
  "domain:limits",
  "domain:transfer",
] as const;
/** 能力名类型。 */
export type Capability = typeof CAPABILITIES[number];

/**
 * 过渡期仍被旧代码引用的能力名。
 *
 * 它们**永不被授予**任何角色：创建者特权（write_own/delete_own）、共享能力
 * （problem:share/training:share）与动态（community:create_moment）都随本次
 * 重构删除。保留联合类型只是为了让尚未迁移的调用点在类型检查中可见，而不是
 * 继续生效。
 */
export const LEGACY_CAPABILITIES = [
  "problem:write_own",
  "problem:delete_own",
  "problem:share",
  "training:write_own",
  "training:delete_own",
  "training:share",
  "community:create_moment",
] as const;
/** 过渡期旧能力名类型。 */
export type LegacyCapability = typeof LEGACY_CAPABILITIES[number];

/** 业务代码可传入的能力名（含待删除的过渡名）。 */
export type CapabilityName = Capability | LegacyCapability;

const MEMBER_CAPABILITIES: readonly CapabilityName[] = [
  "problem:read",
  "submission:create",
  "submission:read_own",
  "contest:participate",
  "training:read",
  "community:read",
  "community:create",
  "community:create_discussion",
  "community:create_solution",
  "community:comment",
  "community:report",
  "user:read_profile",
  "user:search",
];

const EDUCATOR_CAPABILITIES: readonly CapabilityName[] = [
  ...MEMBER_CAPABILITIES,
  "problem:create",
  "problem:publish",
  "problem:import",
  "problem:policy",
  "problem:write_any",
  "problem:delete_any",
  "submission:read_all",
  "submission:rejudge",
  "contest:create",
  "contest:manage",
  "contest:manage_own",
  "contest:anti_cheat_read",
  "training:create",
  "training:read_any",
  "training:write_any",
  "training:delete_any",
  "training:publish",
  "training:pin",
  "training:import",
  "classroom:create",
  "classroom:manage_any",
  "community:moderate",
  "community_moderation:review",
  "community_moderation:hide",
  "community_moderation:lock",
  "community_moderation:sanction",
  "community_board:manage",
];

const ADMIN_CAPABILITIES: readonly CapabilityName[] = [
  ...EDUCATOR_CAPABILITIES,
  "domain:settings",
  "domain:members",
  "domain:invitations",
  "domain:archive",
  "domain:limits",
  "llm:manage",
];

const OWNER_CAPABILITIES: readonly CapabilityName[] = [
  ...ADMIN_CAPABILITIES,
  "domain:transfer",
];

/**
 * 平台管理员能力：域能力的全集加上仅平台可用的能力。
 *
 * 平台管理员凭能力通过路由守卫，但资源所属域、版本、比赛保密、配额等业务
 * 校验仍照常执行；这不是“跳过业务规则”的通行证。
 */
const PLATFORM_ADMIN_CAPABILITIES: readonly CapabilityName[] = [
  ...OWNER_CAPABILITIES,
  "admin:full_access",
  "user:manage",
  "tag:manage",
  "announcement:manage",
  "legal:manage",
  "system:settings",
  "system:judge_images",
  "system:audit_logs",
  "system:ip_bans",
  "problem:field_evaluator_command",
  "problem:field_evaluator_network",
];

function toCapabilitySet(
  values: readonly CapabilityName[],
): ReadonlySet<CapabilityName> {
  return new Set(values);
}

const EMPTY_CAPABILITIES: ReadonlySet<CapabilityName> = new Set();

const CAPABILITIES_BY_DOMAIN_ROLE: Record<
  DomainRole,
  ReadonlySet<CapabilityName>
> = {
  member: toCapabilitySet(MEMBER_CAPABILITIES),
  educator: toCapabilitySet(EDUCATOR_CAPABILITIES),
  admin: toCapabilitySet(ADMIN_CAPABILITIES),
  owner: toCapabilitySet(OWNER_CAPABILITIES),
};

const CAPABILITIES_BY_PLATFORM_ROLE: Record<
  PlatformRole,
  ReadonlySet<CapabilityName>
> = {
  user: toCapabilitySet(MEMBER_CAPABILITIES),
  admin: toCapabilitySet(PLATFORM_ADMIN_CAPABILITIES),
};

/** 平台角色的静态能力集合。 */
export function platformRoleCapabilities(
  role: PlatformRole,
): ReadonlySet<CapabilityName> {
  return CAPABILITIES_BY_PLATFORM_ROLE[role];
}

/** 有效域角色的静态能力集合；无成员关系返回空集，不默认成 member。 */
export function domainRoleCapabilities(
  role: DomainRole | null,
): ReadonlySet<CapabilityName> {
  return role ? CAPABILITIES_BY_DOMAIN_ROLE[role] : EMPTY_CAPABILITIES;
}

/** 域身份的最小投影；只需要负责人字段。 */
export interface DomainIdentity {
  readonly owner_id: string;
}

/** 活跃成员记录的最小投影；只需要单值角色。 */
export interface ActiveDomainMembership {
  readonly role: DomainMemberRole;
}

/**
 * 计算有效域角色：负责人优先，其次成员记录，无成员关系返回 null。
 *
 * owner 不存入成员角色字段；调用方必须已经确认成员记录处于 active 状态。
 */
export function resolveEffectiveDomainRole(
  userId: string,
  domain: DomainIdentity,
  membership: ActiveDomainMembership | null,
): DomainRole | null {
  if (!membership) return null;
  return domain.owner_id === userId ? "owner" : membership.role;
}

/** 该有效角色是否具备指定能力。 */
export function hasDomainCapability(
  role: DomainRole | null,
  capability: CapabilityName,
): boolean {
  return domainRoleCapabilities(role).has(capability);
}

/** 平台角色是否具备指定能力。 */
export function hasPlatformCapability(
  role: PlatformRole,
  capability: CapabilityName,
): boolean {
  return platformRoleCapabilities(role).has(capability);
}
