/**
 * 系统设置注册表（issue #99）。
 *
 * 定义 54 个 DB-backed 设置项的元数据（含 boolean/string/text/integer 四种类型）。
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
 * - judge: 评测资源限制
 * - review: 内容合规审核（issue #413）
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
  | "community"
  | "judge"
  | "review"
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

/** 54 个 DB-backed 设置项的元数据定义 */
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
    description: "邮件服务（disabled / aliyun / tencent）",
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
    key: "rate_limit_search_enabled",
    type: "boolean",
    default: true,
    description: "是否启用搜索速率限制（NOJ_ENV=test 时强制关闭）",
    is_secret: false,
    envFallback: "RATE_LIMIT_SEARCH_ENABLED",
    category: "rate_limit",
  },
  {
    key: "rate_limit_search_window",
    type: "integer",
    default: 30,
    description: "搜索限流窗口（秒）",
    is_secret: false,
    envFallback: "RATE_LIMIT_SEARCH_WINDOW",
    category: "rate_limit",
    min: 1,
    max: 3600,
  },
  {
    key: "rate_limit_search_max_anon",
    type: "integer",
    default: 60,
    description: "匿名 IP 窗口内最大搜索次数",
    is_secret: false,
    envFallback: "RATE_LIMIT_SEARCH_MAX_ANON",
    category: "rate_limit",
    min: 1,
    max: 10000,
  },
  {
    key: "rate_limit_search_max_authed",
    type: "integer",
    default: 120,
    description: "登录用户窗口内最大搜索次数",
    is_secret: false,
    envFallback: "RATE_LIMIT_SEARCH_MAX_AUTHED",
    category: "rate_limit",
    min: 1,
    max: 10000,
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

  // ── community ───────────────────────────────────────────
  {
    key: "community_enabled",
    type: "boolean",
    default: true,
    description: "是否启用社区功能总开关",
    is_secret: false,
    envFallback: "COMMUNITY_ENABLED",
    category: "community",
  },
  {
    key: "community_guest_read_enabled",
    type: "boolean",
    default: false,
    description: "是否允许游客阅读社区公开内容",
    is_secret: false,
    envFallback: "COMMUNITY_GUEST_READ_ENABLED",
    category: "community",
  },
  {
    key: "community_read_only",
    type: "boolean",
    default: false,
    description: "社区只读模式（审核员与管理员除外）",
    is_secret: false,
    envFallback: "COMMUNITY_READ_ONLY",
    category: "community",
  },
  {
    key: "community_solutions_enabled",
    type: "boolean",
    default: true,
    description: "是否启用题解区",
    is_secret: false,
    envFallback: "COMMUNITY_SOLUTIONS_ENABLED",
    category: "community",
  },
  {
    key: "community_discussions_enabled",
    type: "boolean",
    default: true,
    description: "是否启用讨论区",
    is_secret: false,
    envFallback: "COMMUNITY_DISCUSSIONS_ENABLED",
    category: "community",
  },
  {
    key: "community_moments_enabled",
    type: "boolean",
    default: true,
    description: "是否启用用户短动态",
    is_secret: false,
    envFallback: "COMMUNITY_MOMENTS_ENABLED",
    category: "community",
  },
  {
    key: "community_activities_enabled",
    type: "boolean",
    default: true,
    description: "是否展示系统活动流",
    is_secret: false,
    envFallback: "COMMUNITY_ACTIVITIES_ENABLED",
    category: "community",
  },
  {
    key: "community_comments_enabled",
    type: "boolean",
    default: true,
    description: "是否启用评论",
    is_secret: false,
    envFallback: "COMMUNITY_COMMENTS_ENABLED",
    category: "community",
  },
  {
    key: "community_reactions_enabled",
    type: "boolean",
    default: true,
    description: "是否启用点赞",
    is_secret: false,
    envFallback: "COMMUNITY_REACTIONS_ENABLED",
    category: "community",
  },
  {
    key: "community_bookmarks_enabled",
    type: "boolean",
    default: true,
    description: "是否启用收藏",
    is_secret: false,
    envFallback: "COMMUNITY_BOOKMARKS_ENABLED",
    category: "community",
  },
  {
    key: "community_follows_enabled",
    type: "boolean",
    default: true,
    description: "是否启用用户关注",
    is_secret: false,
    envFallback: "COMMUNITY_FOLLOWS_ENABLED",
    category: "community",
  },
  {
    key: "private_messaging_enabled",
    type: "boolean",
    default: true,
    description: "是否启用站内私信",
    is_secret: false,
    envFallback: "PRIVATE_MESSAGING_ENABLED",
    category: "community",
  },
  {
    key: "community_external_images_enabled",
    type: "boolean",
    default: false,
    description: "是否允许 Markdown 渲染 HTTPS 外链图片",
    is_secret: false,
    envFallback: "COMMUNITY_EXTERNAL_IMAGES_ENABLED",
    category: "community",
  },
  {
    key: "community_solution_requires_accepted",
    type: "boolean",
    default: true,
    description: "发布题解是否必须先通过对应题目",
    is_secret: false,
    envFallback: "COMMUNITY_SOLUTION_REQUIRES_ACCEPTED",
    category: "community",
  },
  {
    key: "community_new_user_review_hours",
    type: "integer",
    default: 0,
    description: "注册不足指定小时的用户发布内容需审核（0 为关闭）",
    is_secret: false,
    envFallback: "COMMUNITY_NEW_USER_REVIEW_HOURS",
    category: "community",
    min: 0,
    max: 8760,
  },
  {
    key: "community_post_max_length",
    type: "integer",
    default: 20000,
    description: "题解和讨论正文最大字符数",
    is_secret: false,
    envFallback: "COMMUNITY_POST_MAX_LENGTH",
    category: "community",
    min: 100,
    max: 100000,
  },
  {
    key: "community_moment_max_length",
    type: "integer",
    default: 1000,
    description: "短动态最大字符数",
    is_secret: false,
    envFallback: "COMMUNITY_MOMENT_MAX_LENGTH",
    category: "community",
    min: 20,
    max: 10000,
  },
  {
    key: "community_comment_max_length",
    type: "integer",
    default: 10000,
    description: "评论最大字符数",
    is_secret: false,
    envFallback: "COMMUNITY_COMMENT_MAX_LENGTH",
    category: "community",
    min: 20,
    max: 50000,
  },
  {
    key: "community_post_interval_seconds",
    type: "integer",
    default: 0,
    description: "用户发布内容最小间隔秒数（0 为不限制）",
    is_secret: false,
    envFallback: "COMMUNITY_POST_INTERVAL_SECONDS",
    category: "community",
    min: 0,
    max: 86400,
  },

  // ── judge ───────────────────────────────────────────────
  {
    key: "judge_max_evaluator_time_limit_ms",
    type: "integer",
    default: 0,
    description: "evaluator 单用例时限上限（毫秒），0 = 不限制",
    is_secret: false,
    envFallback: "JUDGE_MAX_EVALUATOR_TIME_LIMIT_MS",
    category: "judge",
    min: 0,
  },
  {
    key: "judge_max_evaluator_memory_limit_mb",
    type: "integer",
    default: 0,
    description: "evaluator 内存上限（MB），0 = 不限制",
    is_secret: false,
    envFallback: "JUDGE_MAX_EVALUATOR_MEMORY_LIMIT_MB",
    category: "judge",
    min: 0,
  },
  {
    key: "judge_max_solution_call_timeout_ms",
    type: "integer",
    default: 0,
    description: "solution 调用超时上限（毫秒），0 = 不限制",
    is_secret: false,
    envFallback: "JUDGE_MAX_SOLUTION_CALL_TIMEOUT_MS",
    category: "judge",
    min: 0,
  },
  {
    key: "judge_max_solution_memory_limit_mb",
    type: "integer",
    default: 0,
    description: "solution 内存上限（MB），0 = 不限制",
    is_secret: false,
    envFallback: "JUDGE_MAX_SOLUTION_MEMORY_LIMIT_MB",
    category: "judge",
    min: 0,
  },

  // ── review（内容合规审核，issue #413）───────────────────────
  {
    key: "content_review_enabled",
    type: "boolean",
    default: false,
    description: "内容合规审核总开关（启用后 UGC 同步审核 + 私信异步送审）",
    is_secret: false,
    envFallback: "CONTENT_REVIEW_ENABLED",
    category: "review",
  },
  {
    key: "content_review_provider",
    type: "string",
    default: "mock",
    description: "审核 Provider（mock / aliyun / tencent / none）",
    is_secret: false,
    envFallback: "CONTENT_REVIEW_PROVIDER",
    category: "review",
  },
  {
    key: "content_review_provider_key",
    type: "string",
    default: "",
    description:
      "审核 Provider AccessKey/SecretId（已脱敏：仅保留前 3 后 3 字符）",
    is_secret: true,
    envFallback: "CONTENT_REVIEW_PROVIDER_KEY",
    category: "review",
  },
  {
    key: "content_review_provider_secret",
    type: "string",
    default: "",
    description: "审核 Provider SecretKey（已脱敏：仅保留前 3 后 3 字符）",
    is_secret: true,
    envFallback: "CONTENT_REVIEW_PROVIDER_SECRET",
    category: "review",
  },
  {
    key: "content_review_risk_threshold",
    type: "integer",
    default: 80,
    description: "高置信违规拦截阈值（0-100，≥ 此值拒绝发布）",
    is_secret: false,
    envFallback: "CONTENT_REVIEW_RISK_THRESHOLD",
    category: "review",
    min: 0,
    max: 100,
  },
  {
    key: "content_review_review_threshold",
    type: "integer",
    default: 50,
    description: "低置信疑似阈值（0-100，≥ 此值转人工审查队列）",
    is_secret: false,
    envFallback: "CONTENT_REVIEW_REVIEW_THRESHOLD",
    category: "review",
    min: 0,
    max: 100,
  },
  {
    key: "content_review_async_enabled",
    type: "boolean",
    default: true,
    description: "私信异步审核队列开关（关闭后私信不再送审）",
    is_secret: false,
    envFallback: "CONTENT_REVIEW_ASYNC_ENABLED",
    category: "review",
  },
  {
    key: "content_review_timeout_ms",
    type: "integer",
    default: 3000,
    description: "审核调用超时（毫秒，超时按 fail-open 转人工）",
    is_secret: false,
    envFallback: "CONTENT_REVIEW_TIMEOUT_MS",
    category: "review",
    min: 100,
    max: 30000,
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
