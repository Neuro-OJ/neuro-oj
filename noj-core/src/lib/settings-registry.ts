/**
 * 系统设置注册表（issue #99）。
 *
 * 定义 22 个 DB-backed 设置项的元数据（含 boolean/string/text/integer 四种类型）。
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

export type SettingType = "boolean" | "string" | "text" | "integer";

export type SettingCategory =
  | "auth"
  | "maintenance"
  | "email"
  | "rate_limit"
  | "storage"
  | "database"
  | "redis"
  | "cors"
  | "other";

/** 注册表条目（DB-backed 设置项的元数据） */
export interface SettingDefinition {
  key: string;
  type: SettingType;
  /** 默认值（DB 与 env 均未配置时回退至此） */
  default: boolean | string | number;
  description: string;
  is_secret: boolean;
  /** env 兜底键名（仅展示用，实际读取走 env-snapshot） */
  envFallback: string;
  category: SettingCategory;
  /** integer 类型专用：最小值（含） */
  min?: number;
  /** integer 类型专用：最大值（含） */
  max?: number;
  /** 修改后需重启 noj-core 才能生效（如启动时单例读取的配置） */
  needsRestart?: boolean;
}

/** 22 个 DB-backed 设置项的元数据定义 */
export const SETTING_DEFINITIONS: readonly SettingDefinition[] = [
  // ── auth ──────────────────────────────────────────────────
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
    key: "jwt_expires_in",
    type: "string",
    default: "24h",
    description: "JWT Token 有效期",
    is_secret: false,
    envFallback: "JWT_EXPIRES_IN",
    category: "auth",
  },

  // ── maintenance ───────────────────────────────────────────
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

  // ── email ─────────────────────────────────────────────────
  {
    key: "email_provider",
    type: "string",
    default: "mock",
    description: "邮件 Provider（mock / aliyun / tencent）",
    is_secret: false,
    envFallback: "EMAIL_PROVIDER",
    category: "email",
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
    key: "alibaba_access_key_id",
    type: "string",
    default: "",
    description: "阿里云 DirectMail AccessKey ID",
    is_secret: false,
    envFallback: "ALIBABA_ACCESS_KEY_ID",
    category: "email",
  },
  {
    key: "alibaba_access_key_secret",
    type: "string",
    default: "",
    description:
      "阿里云 DirectMail AccessKey Secret（已脱敏：仅保留前 3 后 3 字符）",
    is_secret: true,
    envFallback: "ALIBABA_ACCESS_KEY_SECRET",
    category: "email",
  },
  {
    key: "alibaba_from_email",
    type: "string",
    default: "",
    description: "阿里云发信地址（需控制台验证域名）",
    is_secret: false,
    envFallback: "ALIBABA_FROM_EMAIL",
    category: "email",
  },
  {
    key: "tencent_secret_id",
    type: "string",
    default: "",
    description: "腾讯云 SES SecretId",
    is_secret: false,
    envFallback: "TENCENT_SECRET_ID",
    category: "email",
  },
  {
    key: "tencent_secret_key",
    type: "string",
    default: "",
    description: "腾讯云 SES SecretKey（已脱敏：仅保留前 3 后 3 字符）",
    is_secret: true,
    envFallback: "TENCENT_SECRET_KEY",
    category: "email",
  },
  {
    key: "tencent_from_email",
    type: "string",
    default: "",
    description: "腾讯云发信地址（需控制台验证域名）",
    is_secret: false,
    envFallback: "TENCENT_FROM_EMAIL",
    category: "email",
  },
  {
    key: "tencent_region",
    type: "string",
    default: "ap-guangzhou",
    description: "腾讯云地域",
    is_secret: false,
    envFallback: "TENCENT_REGION",
    category: "email",
  },

  // ── rate_limit ────────────────────────────────────────────
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
    key: "rate_limit_enabled",
    type: "boolean",
    default: true,
    description: "速率限制总开关（NOJ_ENV=test 时强制关闭）",
    is_secret: false,
    envFallback: "RATE_LIMIT_ENABLED",
    category: "rate_limit",
  },
  {
    key: "rate_limit_login_ip_window",
    type: "integer",
    default: 30,
    description: "IP 维度限流窗口（秒）",
    is_secret: false,
    envFallback: "RATE_LIMIT_LOGIN_IP_WINDOW",
    category: "rate_limit",
    min: 1,
    max: 3600,
  },
  {
    key: "rate_limit_login_ip_max",
    type: "integer",
    default: 10,
    description: "IP 维度窗口内最大尝试次数",
    is_secret: false,
    envFallback: "RATE_LIMIT_LOGIN_IP_MAX",
    category: "rate_limit",
    min: 1,
    max: 1000,
  },
  {
    key: "rate_limit_login_acc_window",
    type: "integer",
    default: 30,
    description: "账号维度限流窗口（秒）",
    is_secret: false,
    envFallback: "RATE_LIMIT_LOGIN_ACC_WINDOW",
    category: "rate_limit",
    min: 1,
    max: 3600,
  },
  {
    key: "rate_limit_login_acc_max",
    type: "integer",
    default: 5,
    description: "账号维度窗口内最大尝试次数",
    is_secret: false,
    envFallback: "RATE_LIMIT_LOGIN_ACC_MAX",
    category: "rate_limit",
    min: 1,
    max: 100,
  },
  {
    key: "rate_limit_login_backoff_sec",
    type: "integer",
    default: 15,
    description: "每次失败退避秒数",
    is_secret: false,
    envFallback: "RATE_LIMIT_LOGIN_BACKOFF_SEC",
    category: "rate_limit",
    min: 0,
    max: 300,
  },
  {
    key: "rate_limit_login_lock_threshold",
    type: "integer",
    default: 10,
    description: "连续失败锁定阈值",
    is_secret: false,
    envFallback: "RATE_LIMIT_LOGIN_LOCK_THRESHOLD",
    category: "rate_limit",
    min: 1,
    max: 100,
  },
  {
    key: "rate_limit_login_lock_seconds",
    type: "integer",
    default: 3600,
    description: "锁定时长（秒）",
    is_secret: false,
    envFallback: "RATE_LIMIT_LOGIN_LOCK_SECONDS",
    category: "rate_limit",
    min: 60,
    max: 86400,
  },
  {
    key: "trusted_proxies",
    type: "string",
    default: "",
    description: "可信代理白名单（IP/CIDR，逗号分隔）",
    is_secret: false,
    envFallback: "TRUSTED_PROXIES",
    category: "rate_limit",
  },

  // ── storage（修改需重启 noj-core：Provider 为启动时初始化的单例）───────
  {
    key: "storage_provider",
    type: "string",
    default: "local",
    description: "存储 Provider（local / s3）",
    is_secret: false,
    envFallback: "STORAGE_PROVIDER",
    category: "storage",
    needsRestart: true,
  },
  {
    key: "s3_endpoint",
    type: "string",
    default: "",
    description: "S3 兼容对象存储端点",
    is_secret: false,
    envFallback: "S3_ENDPOINT",
    category: "storage",
    needsRestart: true,
  },
  {
    key: "s3_region",
    type: "string",
    default: "us-east-1",
    description: "S3 区域",
    is_secret: false,
    envFallback: "S3_REGION",
    category: "storage",
    needsRestart: true,
  },
  {
    key: "s3_access_key",
    type: "string",
    default: "",
    description: "S3 访问密钥",
    is_secret: false,
    envFallback: "S3_ACCESS_KEY",
    category: "storage",
    needsRestart: true,
  },
  {
    key: "s3_secret_key",
    type: "string",
    default: "",
    description: "S3 秘密密钥（已脱敏：仅保留前 3 后 3 字符）",
    is_secret: true,
    envFallback: "S3_SECRET_KEY",
    category: "storage",
    needsRestart: true,
  },
  {
    key: "s3_bucket",
    type: "string",
    default: "noj-support-packages",
    description: "S3 存储桶名",
    is_secret: false,
    envFallback: "S3_BUCKET",
    category: "storage",
    needsRestart: true,
  },
  {
    key: "s3_force_path_style",
    type: "boolean",
    default: false,
    description: "启用路径风格 URL（MinIO 等 S3 兼容存储需要设为 true）",
    is_secret: false,
    envFallback: "S3_FORCE_PATH_STYLE",
    category: "storage",
    needsRestart: true,
  },

  // ── other ─────────────────────────────────────────────────
  {
    key: "audit_log_retention_days",
    type: "integer",
    default: 90,
    description: "审计日志保留天数（0 = 禁用自动清理）",
    is_secret: false,
    envFallback: "AUDIT_LOG_RETENTION_DAYS",
    category: "other",
    min: 0,
    max: 365,
  },
] as const;

const VALID_TYPES: readonly SettingType[] = [
  "boolean",
  "string",
  "text",
  "integer",
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

    // integer 类型需校验 min ≤ max
    if (
      def.type === "integer" && def.min !== undefined && def.max !== undefined
    ) {
      if (def.min > def.max) {
        throw new Error(
          `[settings-registry] ${def.key} 的 min（${def.min}）大于 max（${def.max}）`,
        );
      }
    }
  }
}

/** 按 key 快速查找注册表条目（O(1) 命中，miss 返回 undefined） */
export function findDefinition(key: string): SettingDefinition | undefined {
  return SETTING_DEFINITIONS.find((d) => d.key === key);
}
