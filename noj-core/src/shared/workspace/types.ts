/** 产品工作空间的共享契约；不依赖任何业务域。 */
import { DOMAIN_ROLES, type DomainRole } from "../access/roles.ts";

/** 默认工作空间的稳定标识。 */
export const DEFAULT_DOMAIN_ID = "00000000-0000-4000-8000-000000000001";
/** 默认工作空间的稳定网址标识。 */
export const DEFAULT_DOMAIN_SLUG = "main";
/** 有效域角色集合；定义在 shared/access/roles.ts，这里只做转出。 */
export { DOMAIN_ROLES };
/** 工作空间有效角色（含负责人）。 */
export type { DomainRole };
/** 工作空间生命周期。 */
export type DomainStatus = "active" | "archived" | "suspended";
/** 创建后固定的三种域类型。 */
export const DOMAIN_PRESETS = ["community", "education", "team"] as const;
/** 新建域及创建申请只接受三种类型。 */
export type DomainPreset = typeof DOMAIN_PRESETS[number];
/** 存量自定义域保留读取，转换须由管理员明确决定。 */
export type StoredDomainPreset = DomainPreset | "custom";
/** 由域类型决定、受实例政策约束的能力。 */
export interface DomainFeatures {
  community: boolean;
  classroom: boolean;
  assignment: boolean;
  analytics: boolean;
}
/**
 * 数据库只持久化的域配置事实：访问、发现与加入政策。
 *
 * 能力与首页由域类型和实例政策推导，不再存储、也不接受客户端写入。
 */
export interface StoredDomainConfiguration {
  access: "public" | "members";
  discoverable: boolean;
  join_policy: "open" | "approval" | "invite";
}
/** 读取、导航与 BFF 使用的有效配置：存储事实 + 推导出的能力与首页。 */
export interface EffectiveDomainConfiguration
  extends StoredDomainConfiguration {
  features: DomainFeatures;
  homepage: "overview" | "community" | "teaching" | "training";
}
/** 过渡别名：调用方逐步改用 EffectiveDomainConfiguration。 */
export type DomainConfiguration = EffectiveDomainConfiguration;
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
}
/** 跨域资源配额：null 表示不额外限制，0 表示禁止。 */
export interface DomainLimits {
  members: number | null;
  problems: number | null;
  storage_bytes: number | null;
  submissions_per_minute: number | null;
}
