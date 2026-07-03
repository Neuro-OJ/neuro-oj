/**
 * 系统设置注册表（issue #99）。
 *
 * 定义 5 个 DB-backed 设置项的元数据。
 * 启动期 validateRegistry() 校验注册表合法性；
 * service 层 updateSetting/getSetting 依赖本表做严格 type 校验。
 *
 * 分类（category）用于管理后台 UI 分组：
 * - auth: 认证 / 用户管理
 * - maintenance: 维护 / 公告
 * - email: 邮件发送
 * - rate_limit: 速率限制
 * - database: 数据库
 * - redis: Redis
 * - cors: 跨域
 * - other: 其他
 */

export type SettingType = "boolean" | "string" | "text";

export type SettingCategory =
  | "auth"
  | "maintenance"
  | "email"
  | "rate_limit"
  | "database"
  | "redis"
  | "cors"
  | "other";

/** 注册表条目（DB-backed 设置项的元数据） */
export interface SettingDefinition {
  key: string;
  type: SettingType;
  /** 默认值（DB 与 env 均未配置时回退至此） */
  default: boolean | string;
  description: string;
  is_secret: boolean;
  /** env 兜底键名（仅展示用，实际读取走 env-snapshot） */
  envFallback: string;
  category: SettingCategory;
}

/** 5 个 DB-backed 设置项的元数据定义 */
export const SETTING_DEFINITIONS: readonly SettingDefinition[] = [
  {
    key: "allow_register",
    type: "boolean",
    default: true,
    description: "是否开放新用户注册（关闭后 /api/v1/auth/register 返回 403）",
    is_secret: false,
    envFallback: "ALLOW_REGISTER",
    category: "auth",
  },
  {
    key: "smtp_from",
    type: "string",
    default: "",
    description: "系统发件人地址（邮件 Provider 通用）",
    is_secret: false,
    envFallback: "SMTP_FROM",
    category: "email",
  },
  {
    key: "rate_limit_login_enabled",
    type: "boolean",
    default: true,
    description: "是否启用登录速率限制（NOJ_ENV=test 时强制关闭）",
    is_secret: false,
    envFallback: "RATE_LIMIT_LOGIN_ENABLED",
    category: "rate_limit",
  },
  {
    key: "maintenance_mode",
    type: "boolean",
    default: false,
    description: "维护模式（启用后写操作 API 返回 503，仅读操作可用）",
    is_secret: false,
    envFallback: "MAINTENANCE_MODE",
    category: "maintenance",
  },
  {
    key: "homepage_banner",
    type: "text",
    default: "",
    description: "首页顶部公告（最多 1000 字符）",
    is_secret: false,
    envFallback: "HOMEPAGE_BANNER",
    category: "maintenance",
  },
] as const;

const VALID_TYPES: readonly SettingType[] = [
  "boolean",
  "string",
  "text",
] as const;

/** 启动期注册表校验：key 唯一、type 合法 */
export function validateRegistry(): void {
  const seen = new Set<string>();
  for (const def of SETTING_DEFINITIONS) {
    if (seen.has(def.key)) {
      throw new Error(
        `[settings-registry] 重复的 key: ${def.key}（每个设置项 key 必须唯一）`,
      );
    }
    seen.add(def.key);

    if (!VALID_TYPES.includes(def.type)) {
      throw new Error(
        `[settings-registry] 非法 type: ${def.key} -> ${def.type}（合法值: ${
          VALID_TYPES.join(", ")
        }）`,
      );
    }
  }
}

/** 按 key 快速查找注册表条目（O(1) 命中，miss 返回 undefined） */
export function findDefinition(key: string): SettingDefinition | undefined {
  return SETTING_DEFINITIONS.find((d) => d.key === key);
}
