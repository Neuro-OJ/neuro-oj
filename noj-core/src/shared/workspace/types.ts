/** 产品工作空间的共享契约；不依赖任何业务域。 */
export const DEFAULT_DOMAIN_ID = "00000000-0000-4000-8000-000000000001";
/** 默认工作空间的稳定网址标识。 */
export const DEFAULT_DOMAIN_SLUG = "main";
/** 内置角色只授予当前工作空间能力，不包含平台权限。 */
export const DOMAIN_ROLES = [
  "owner",
  "admin",
  "editor",
  "educator",
  "moderator",
  "member",
] as const;
/** 工作空间成员角色。 */
export type DomainRole = typeof DOMAIN_ROLES[number];
/** 工作空间生命周期。 */
export type DomainStatus = "active" | "archived" | "suspended";
/** 初始化模板，不参与后续权限判断。 */
export type DomainPreset = "community" | "education" | "team" | "custom";
/** 工作空间可选功能。 */
export interface DomainFeatures {
  community: boolean;
  classroom: boolean;
  assignment: boolean;
  analytics: boolean;
}
/** 工作空间配置，访问、发现、功能和首页相互独立。 */
export interface DomainConfiguration {
  access: "public" | "members";
  discoverable: boolean;
  join_policy: "open" | "approval" | "invite";
  features: DomainFeatures;
  homepage: "overview" | "community" | "teaching" | "training";
}
/** URL 解析后的请求上下文；不能代替具体资源授权。 */
export interface WorkspaceContext {
  domainId: string;
  domainSlug: string;
  actorId: string | null;
  platformPermissions: ReadonlySet<string>;
  domainPermissions: ReadonlySet<string>;
  domainRevision: number;
}
/** 人类可读题号与稳定内部身份分离。 */
export interface ProblemReference {
  problem_id: string;
  source_domain_id: string;
  source_domain_slug: string;
  number: number;
  qualified_ref: string;
  display_ref: string;
  is_shared: boolean;
}
/** 跨域资源配额：null 表示不额外限制，0 表示禁止。 */
export interface DomainLimits {
  members: number | null;
  problems: number | null;
  storage_bytes: number | null;
  submissions_per_minute: number | null;
}
