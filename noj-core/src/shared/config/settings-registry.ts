/**
 * 统一配置注册表（issue #99 演进：配置分层语义治理）。
 *
 * 定义全部配置项的元数据，按 scope 分为两类生命周期：
 * - runtime（DB-owned）：运行时可热改，读取链 DB > env 兜底 > default；
 * - bootstrap（env-owned）：启动期定型，变更需重启，读取链 env > default（不读 DB）。
 *
 * 覆盖三类来源：
 * - 原 DB-backed 设置项（admin 可改）；
 * - 原 env-only 展示项（启动期快照、后台只读）；
 * - 纯 infra/ops env（TFA/OAuth/LLM/日志等，后台只读，无配置盲区）。
 *
 * 启动期 validateRegistry() 校验注册表合法性（scope 声明完整、env 键唯一）。
 *
 * 分类（category）用于管理后台 UI 分组：
 * - auth: 认证 / 用户管理
 * - maintenance: 维护 / 公告
 * - email: 邮件发送（bootstrap 启动期配置）
 * - rate_limit: 速率限制
 * - database: 数据库
 * - redis: Redis
 * - cors: 跨域
 * - storage: 对象存储（bootstrap 启动期配置）
 * - judge: 评测资源限制
 * - review: 内容合规审核（issue #413）
 * - other: 其他
 */

export type SettingType = "boolean" | "string" | "text" | "integer";

export type ConfigScope = "runtime" | "bootstrap";

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

/** 配置项元数据（统一注册表条目） */
export interface SettingDefinition {
  key: string;
  type: SettingType;
  /** 默认值（DB 与 env 均未配置时回退至此；bootstrap env-only 项可无默认值） */
  default?: boolean | string | number;
  description: string;
  is_secret: boolean;
  /** 生命周期归属：runtime=DB 可热改；bootstrap=env 启动期定型只读 */
  scope: ConfigScope;
  /** runtime 专属：env 兜底键名（仅首次启动/开发环境兜底用） */
  envFallback?: string;
  /** bootstrap 专属：env 事实源键名（唯一） */
  envKey?: string;
  category: SettingCategory;
  /** integer 类型专用：最小值（含） */
  min?: number;
  /** integer 类型专用：最大值（含） */
  max?: number;
  /** 修改后需重启 noj-core 才能生效（如启动时单例读取的配置） */
  needsRestart?: boolean;
  /** 是否在管理后台展示（false=仅参与校验/登记，如开发测试专用键） */
  visible?: boolean;
}

/** 统一配置注册表：全部配置项（runtime + bootstrap）的元数据定义 */
export const CONFIG_DEFINITIONS: readonly SettingDefinition[] = [
  // 数据说明只公开以下专用字段，运营者补充真实部署信息。
  {
    key: "data_policy_contact",
    type: "string",
    default: "",
    description: "数据使用与注销反馈渠道（公开展示，请填写实际邮箱或联系说明）",
    is_secret: false,
    scope: "runtime",
    envFallback: "DATA_POLICY_CONTACT",
    category: "other",
  },
  {
    key: "data_policy_deployment",
    type: "text",
    default: "",
    description:
      "数据说明的部署补充：运营主体、存储区域、保留期限、备份、第三方服务及额外用途（公开纯文本）",
    is_secret: false,
    scope: "runtime",
    envFallback: "DATA_POLICY_DEPLOYMENT",
    category: "other",
  },
  // ── auth ──────────────────────────────────────────────────
  {
    key: "allow_register",
    type: "boolean",
    default: true,
    description: "是否开放新用户注册（关闭后 /api/v1/auth/register 返回 403）",
    is_secret: false,
    envFallback: "ALLOW_REGISTER",
    category: "auth",
    scope: "runtime",
  },
  {
    key: "jwt_expires_in",
    type: "string",
    default: "24h",
    description: "JWT Token 有效期",
    is_secret: false,
    envFallback: "JWT_EXPIRES_IN",
    category: "auth",
    scope: "runtime",
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
    scope: "runtime",
  },
  {
    key: "homepage_banner",
    type: "text",
    default: "",
    description: "首页顶部公告（最多 1000 字符）",
    is_secret: false,
    envFallback: "HOMEPAGE_BANNER",
    category: "maintenance",
    scope: "runtime",
  },

  // ── email ─────────────────────────────────────────────────
  {
    key: "email_provider",
    type: "string",
    default: "mock",
    description: "邮件服务（disabled / aliyun / tencent）",
    is_secret: false,
    envKey: "EMAIL_PROVIDER",
    category: "email",
    scope: "bootstrap",
  },
  {
    key: "smtp_from",
    type: "string",
    default: "",
    description: "系统发件人地址（邮件 Provider 通用）",
    is_secret: false,
    envKey: "SMTP_FROM",
    category: "email",
    scope: "bootstrap",
  },
  {
    key: "alibaba_access_key_id",
    type: "string",
    default: "",
    description: "阿里云 DirectMail AccessKey ID",
    is_secret: false,
    envKey: "ALIBABA_ACCESS_KEY_ID",
    category: "email",
    scope: "bootstrap",
  },
  {
    key: "alibaba_access_key_secret",
    type: "string",
    default: "",
    description:
      "阿里云 DirectMail AccessKey Secret（已脱敏：仅保留前 3 后 3 字符）",
    is_secret: true,
    envKey: "ALIBABA_ACCESS_KEY_SECRET",
    category: "email",
    scope: "bootstrap",
  },
  {
    key: "alibaba_from_email",
    type: "string",
    default: "",
    description: "阿里云发信地址（需控制台验证域名）",
    is_secret: false,
    envKey: "ALIBABA_FROM_EMAIL",
    category: "email",
    scope: "bootstrap",
  },
  {
    key: "tencent_secret_id",
    type: "string",
    default: "",
    description: "腾讯云 SES SecretId",
    is_secret: false,
    envKey: "TENCENT_SECRET_ID",
    category: "email",
    scope: "bootstrap",
  },
  {
    key: "tencent_secret_key",
    type: "string",
    default: "",
    description: "腾讯云 SES SecretKey（已脱敏：仅保留前 3 后 3 字符）",
    is_secret: true,
    envKey: "TENCENT_SECRET_KEY",
    category: "email",
    scope: "bootstrap",
  },
  {
    key: "tencent_from_email",
    type: "string",
    default: "",
    description: "腾讯云发信地址（需控制台验证域名）",
    is_secret: false,
    envKey: "TENCENT_FROM_EMAIL",
    category: "email",
    scope: "bootstrap",
  },
  {
    key: "tencent_region",
    type: "string",
    default: "ap-guangzhou",
    description: "腾讯云地域",
    is_secret: false,
    envKey: "TENCENT_REGION",
    category: "email",
    scope: "bootstrap",
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
    scope: "runtime",
  },
  {
    key: "rate_limit_enabled",
    type: "boolean",
    default: true,
    description: "速率限制总开关（NOJ_ENV=test 时强制关闭）",
    is_secret: false,
    envFallback: "RATE_LIMIT_ENABLED",
    category: "rate_limit",
    scope: "runtime",
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
    scope: "runtime",
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
    scope: "runtime",
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
    scope: "runtime",
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
    scope: "runtime",
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
    scope: "runtime",
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
    scope: "runtime",
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
    scope: "runtime",
  },
  {
    key: "rate_limit_search_enabled",
    type: "boolean",
    default: true,
    description: "是否启用搜索速率限制（NOJ_ENV=test 时强制关闭）",
    is_secret: false,
    envFallback: "RATE_LIMIT_SEARCH_ENABLED",
    category: "rate_limit",
    scope: "runtime",
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
    scope: "runtime",
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
    scope: "runtime",
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
    scope: "runtime",
  },
  {
    key: "trusted_proxies",
    type: "string",
    default: "",
    description: "可信代理白名单（IP/CIDR，逗号分隔）",
    is_secret: false,
    envFallback: "TRUSTED_PROXIES",
    category: "rate_limit",
    scope: "runtime",
  },

  // ── storage（修改需重启 noj-core：Provider 为启动时初始化的单例）───────
  {
    key: "storage_provider",
    type: "string",
    default: "local",
    description: "存储 Provider（local / s3）",
    is_secret: false,
    envKey: "STORAGE_PROVIDER",
    category: "storage",
    needsRestart: true,
    scope: "bootstrap",
  },
  {
    key: "s3_endpoint",
    type: "string",
    default: "",
    description: "S3 兼容对象存储端点",
    is_secret: false,
    envKey: "S3_ENDPOINT",
    category: "storage",
    needsRestart: true,
    scope: "bootstrap",
  },
  {
    key: "s3_region",
    type: "string",
    default: "us-east-1",
    description: "S3 区域",
    is_secret: false,
    envKey: "S3_REGION",
    category: "storage",
    needsRestart: true,
    scope: "bootstrap",
  },
  {
    key: "s3_access_key",
    type: "string",
    default: "",
    description: "S3 访问密钥",
    is_secret: false,
    envKey: "S3_ACCESS_KEY",
    category: "storage",
    needsRestart: true,
    scope: "bootstrap",
  },
  {
    key: "s3_secret_key",
    type: "string",
    default: "",
    description: "S3 秘密密钥（已脱敏：仅保留前 3 后 3 字符）",
    is_secret: true,
    envKey: "S3_SECRET_KEY",
    category: "storage",
    needsRestart: true,
    scope: "bootstrap",
  },
  {
    key: "s3_bucket",
    type: "string",
    default: "noj-support-packages",
    description: "S3 存储桶名",
    is_secret: false,
    envKey: "S3_BUCKET",
    category: "storage",
    needsRestart: true,
    scope: "bootstrap",
  },
  {
    key: "s3_force_path_style",
    type: "boolean",
    default: false,
    description: "启用路径风格 URL（MinIO 等 S3 兼容存储需要设为 true）",
    is_secret: false,
    envKey: "S3_FORCE_PATH_STYLE",
    category: "storage",
    needsRestart: true,
    scope: "bootstrap",
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
    scope: "runtime",
  },
  {
    key: "community_guest_read_enabled",
    type: "boolean",
    default: false,
    description: "是否允许游客阅读社区公开内容",
    is_secret: false,
    envFallback: "COMMUNITY_GUEST_READ_ENABLED",
    category: "community",
    scope: "runtime",
  },
  {
    key: "community_read_only",
    type: "boolean",
    default: false,
    description: "社区只读模式（审核员与管理员除外）",
    is_secret: false,
    envFallback: "COMMUNITY_READ_ONLY",
    category: "community",
    scope: "runtime",
  },
  {
    key: "community_solutions_enabled",
    type: "boolean",
    default: true,
    description: "是否启用题解区",
    is_secret: false,
    envFallback: "COMMUNITY_SOLUTIONS_ENABLED",
    category: "community",
    scope: "runtime",
  },
  {
    key: "community_discussions_enabled",
    type: "boolean",
    default: true,
    description: "是否启用讨论区",
    is_secret: false,
    envFallback: "COMMUNITY_DISCUSSIONS_ENABLED",
    category: "community",
    scope: "runtime",
  },
  {
    key: "community_moments_enabled",
    type: "boolean",
    default: true,
    description: "是否启用用户短动态",
    is_secret: false,
    envFallback: "COMMUNITY_MOMENTS_ENABLED",
    category: "community",
    scope: "runtime",
  },
  {
    key: "community_activities_enabled",
    type: "boolean",
    default: true,
    description: "是否展示系统活动流",
    is_secret: false,
    envFallback: "COMMUNITY_ACTIVITIES_ENABLED",
    category: "community",
    scope: "runtime",
  },
  {
    key: "community_comments_enabled",
    type: "boolean",
    default: true,
    description: "是否启用评论",
    is_secret: false,
    envFallback: "COMMUNITY_COMMENTS_ENABLED",
    category: "community",
    scope: "runtime",
  },
  {
    key: "community_reactions_enabled",
    type: "boolean",
    default: true,
    description: "是否启用点赞",
    is_secret: false,
    envFallback: "COMMUNITY_REACTIONS_ENABLED",
    category: "community",
    scope: "runtime",
  },
  {
    key: "community_bookmarks_enabled",
    type: "boolean",
    default: true,
    description: "是否启用收藏",
    is_secret: false,
    envFallback: "COMMUNITY_BOOKMARKS_ENABLED",
    category: "community",
    scope: "runtime",
  },
  {
    key: "community_follows_enabled",
    type: "boolean",
    default: true,
    description: "是否启用用户关注",
    is_secret: false,
    envFallback: "COMMUNITY_FOLLOWS_ENABLED",
    category: "community",
    scope: "runtime",
  },
  {
    key: "private_messaging_enabled",
    type: "boolean",
    default: true,
    description: "是否启用站内私信",
    is_secret: false,
    envFallback: "PRIVATE_MESSAGING_ENABLED",
    category: "community",
    scope: "runtime",
  },
  {
    key: "community_external_images_enabled",
    type: "boolean",
    default: false,
    description: "是否允许 Markdown 渲染 HTTPS 外链图片",
    is_secret: false,
    envFallback: "COMMUNITY_EXTERNAL_IMAGES_ENABLED",
    category: "community",
    scope: "runtime",
  },
  {
    key: "community_solution_requires_accepted",
    type: "boolean",
    default: true,
    description: "发布题解是否必须先通过对应题目",
    is_secret: false,
    envFallback: "COMMUNITY_SOLUTION_REQUIRES_ACCEPTED",
    category: "community",
    scope: "runtime",
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
    scope: "runtime",
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
    scope: "runtime",
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
    scope: "runtime",
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
    scope: "runtime",
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
    scope: "runtime",
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
    scope: "runtime",
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
    scope: "runtime",
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
    scope: "runtime",
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
    scope: "runtime",
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
    scope: "runtime",
  },
  {
    key: "content_review_provider",
    type: "string",
    default: "mock",
    description: "审核 Provider（mock / aliyun / tencent / none）",
    is_secret: false,
    envFallback: "CONTENT_REVIEW_PROVIDER",
    category: "review",
    scope: "runtime",
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
    scope: "runtime",
  },
  {
    key: "content_review_provider_secret",
    type: "string",
    default: "",
    description: "审核 Provider SecretKey（已脱敏：仅保留前 3 后 3 字符）",
    is_secret: true,
    envFallback: "CONTENT_REVIEW_PROVIDER_SECRET",
    category: "review",
    scope: "runtime",
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
    scope: "runtime",
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
    scope: "runtime",
  },
  {
    key: "content_review_async_enabled",
    type: "boolean",
    default: true,
    description: "私信异步审核队列开关（关闭后私信不再送审）",
    is_secret: false,
    envFallback: "CONTENT_REVIEW_ASYNC_ENABLED",
    category: "review",
    scope: "runtime",
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
    scope: "runtime",
  },

  // ── other ─────────────────────────────────────────────────
  {
    key: "audit_log_retention_days",
    type: "integer",
    default: 90,
    description: "审计日志保留天数（0 = 禁用自动清理）",
    is_secret: false,
    envKey: "AUDIT_LOG_RETENTION_DAYS",
    category: "other",
    min: 0,
    max: 365,
    scope: "bootstrap",
  },

  // ══ bootstrap env-only 基础设施项（原 env-snapshot 白名单）══════
  // scope: bootstrap，envKey 即 env 事实源；后台只读展示（已设置才展示）。
  // ── database ───────────────────────────────────────────────
  {
    key: "DATABASE_URL",
    type: "string",
    description: "PostgreSQL 连接串",
    is_secret: true,
    scope: "bootstrap",
    envKey: "DATABASE_URL",
    category: "database",
  },
  {
    key: "DATABASE_POOL_MAX",
    type: "integer",
    description: "连接池大小",
    is_secret: false,
    scope: "bootstrap",
    envKey: "DATABASE_POOL_MAX",
    category: "database",
  },
  {
    key: "DATABASE_CONNECT_TIMEOUT",
    type: "integer",
    description: "连接超时（秒）",
    is_secret: false,
    scope: "bootstrap",
    envKey: "DATABASE_CONNECT_TIMEOUT",
    category: "database",
  },
  {
    key: "DATABASE_IDLE_TIMEOUT",
    type: "integer",
    description: "空闲连接超时（秒）",
    is_secret: false,
    scope: "bootstrap",
    envKey: "DATABASE_IDLE_TIMEOUT",
    category: "database",
  },
  {
    key: "DATABASE_MAX_LIFETIME",
    type: "integer",
    description: "连接最大生命周期（秒）",
    is_secret: false,
    scope: "bootstrap",
    envKey: "DATABASE_MAX_LIFETIME",
    category: "database",
  },
  // ── Redis ──────────────────────────────────────────────────
  {
    key: "REDIS_URL",
    type: "string",
    description: "Redis 连接串",
    is_secret: true,
    scope: "bootstrap",
    envKey: "REDIS_URL",
    category: "redis",
  },
  // ── auth ───────────────────────────────────────────────────
  {
    key: "JWT_SECRET",
    type: "string",
    description: "JWT 签名密钥（≥32 字符）",
    is_secret: true,
    scope: "bootstrap",
    envKey: "JWT_SECRET",
    category: "auth",
  },
  {
    key: "ADMIN_EMAIL",
    type: "string",
    description: "Seed 管理员邮箱",
    is_secret: false,
    scope: "bootstrap",
    envKey: "ADMIN_EMAIL",
    category: "auth",
  },
  {
    key: "ADMIN_PASS",
    type: "string",
    description: "Seed 管理员密码",
    is_secret: true,
    scope: "bootstrap",
    envKey: "ADMIN_PASS",
    category: "auth",
  },
  {
    key: "BCRYPT_SALT_ROUNDS",
    type: "integer",
    description: "bcrypt 哈希轮数（修改影响已有密码一致性）",
    is_secret: false,
    scope: "bootstrap",
    envKey: "BCRYPT_SALT_ROUNDS",
    category: "auth",
  },
  // ── CORS ───────────────────────────────────────────────────
  {
    key: "CORS_ALLOWED_ORIGINS",
    type: "string",
    description: "生产 CORS 白名单（逗号分隔）",
    is_secret: false,
    scope: "bootstrap",
    envKey: "CORS_ALLOWED_ORIGINS",
    category: "cors",
  },
  // ── other（端口 / 环境）────────────────────────────────────
  {
    key: "PORT",
    type: "integer",
    description: "HTTP 监听端口",
    is_secret: false,
    scope: "bootstrap",
    envKey: "PORT",
    category: "other",
  },
  {
    key: "NOJ_ENV",
    type: "string",
    description: "运行环境（空=development，production=生产）",
    is_secret: false,
    scope: "bootstrap",
    envKey: "NOJ_ENV",
    category: "other",
  },

  // ══ bootstrap 纯 infra/ops env（仅登记与展示，不改读取路径）══════
  // ── 密钥类 ─────────────────────────────────────────────────
  {
    key: "TFA_ENCRYPTION_KEY",
    type: "string",
    description:
      "TOTP secret 的 AES-256-GCM 加密密钥（≥32 字符，与 JWT_SECRET 隔离）",
    is_secret: true,
    scope: "bootstrap",
    envKey: "TFA_ENCRYPTION_KEY",
    category: "auth",
  },
  {
    key: "NOJ_LLM_SERVICE_TOKEN",
    type: "string",
    description: "noj-llm-gateway 服务间鉴权 + AEAD eval_token 签发/校验密钥",
    is_secret: true,
    scope: "bootstrap",
    envKey: "NOJ_LLM_SERVICE_TOKEN",
    category: "other",
  },
  // ── 应用 URL / 网络 ────────────────────────────────────────
  {
    key: "APP_URL",
    type: "string",
    description:
      "外部可信应用地址（密码重置邮件链接 / OAuth 回调，生产必须 HTTPS）",
    is_secret: false,
    scope: "bootstrap",
    envKey: "APP_URL",
    category: "auth",
  },
  {
    key: "NOJ_ALLOW_INSECURE_HTTP",
    type: "boolean",
    description: "允许 HTTP 明文回调（仅开发；生产必须为 false）",
    is_secret: false,
    scope: "bootstrap",
    envKey: "NOJ_ALLOW_INSECURE_HTTP",
    category: "other",
  },
  {
    key: "NOJ_LLM_GATEWAY_URL",
    type: "string",
    description: "noj-llm-gateway 内部服务地址",
    is_secret: false,
    scope: "bootstrap",
    envKey: "NOJ_LLM_GATEWAY_URL",
    category: "other",
  },
  // ── 日志 ───────────────────────────────────────────────────
  {
    key: "LOG_LEVEL",
    type: "string",
    description: "日志级别（debug/info/warn/error；未设置按 NOJ_ENV 回退）",
    is_secret: false,
    scope: "bootstrap",
    envKey: "LOG_LEVEL",
    category: "other",
  },
  {
    key: "LOG_FORMAT",
    type: "string",
    description: "日志格式（json/pretty；未设置按 NOJ_ENV 回退）",
    is_secret: false,
    scope: "bootstrap",
    envKey: "LOG_FORMAT",
    category: "other",
  },
  // ── 评测 / 存储 / 运行参数 ─────────────────────────────────
  {
    key: "RESULT_CONSUMER_CONCURRENCY",
    type: "integer",
    description: "评测结果消费者并发数（1-16）",
    is_secret: false,
    scope: "bootstrap",
    envKey: "RESULT_CONSUMER_CONCURRENCY",
    category: "judge",
  },
  {
    key: "SUPPORT_PACKAGE_DIR",
    type: "string",
    description: "本地存储目录（local Provider）",
    is_secret: false,
    scope: "bootstrap",
    envKey: "SUPPORT_PACKAGE_DIR",
    category: "storage",
  },
  {
    key: "JUDGE_IMAGE_BASE",
    type: "string",
    description: "Judge 镜像仓库前缀",
    is_secret: false,
    scope: "bootstrap",
    envKey: "JUDGE_IMAGE_BASE",
    category: "judge",
  },
  {
    key: "NOJ_ARTIFACT_MAX_SIZE_MB",
    type: "integer",
    description: "artifact 提交硬上限（MB），默认 2048",
    is_secret: false,
    scope: "bootstrap",
    envKey: "NOJ_ARTIFACT_MAX_SIZE_MB",
    category: "judge",
  },
  // ── LLM 网关配额（core 侧读的 env 常量）────────────────────
  {
    key: "NOJ_LLM_MAX_CALLS",
    type: "integer",
    description: "单次评测 eval_token 调用上限（默认 100）",
    is_secret: false,
    scope: "bootstrap",
    envKey: "NOJ_LLM_MAX_CALLS",
    category: "other",
  },
  {
    key: "NOJ_LLM_MAX_TOKENS",
    type: "integer",
    description: "单次评测 eval_token token 上限（默认 50000）",
    is_secret: false,
    scope: "bootstrap",
    envKey: "NOJ_LLM_MAX_TOKENS",
    category: "other",
  },
  // ── 种子 / 引导行为 ────────────────────────────────────────
  {
    key: "NOJ_FORCE_PASSWORD_CHANGE",
    type: "boolean",
    description: "引导管理员是否强制首次改密（默认 true；开发自动 false）",
    is_secret: false,
    scope: "bootstrap",
    envKey: "NOJ_FORCE_PASSWORD_CHANGE",
    category: "auth",
  },
  {
    key: "NOJ_LLM_DEFAULT_GLOBAL_DAY_CALLS",
    type: "integer",
    description: "LLM 配额缺失 fallback：全局日调用上限",
    is_secret: false,
    scope: "bootstrap",
    envKey: "NOJ_LLM_DEFAULT_GLOBAL_DAY_CALLS",
    category: "other",
  },
  {
    key: "NOJ_LLM_DEFAULT_GLOBAL_DAY_TOKENS",
    type: "integer",
    description: "LLM 配额缺失 fallback：全局日 token 上限",
    is_secret: false,
    scope: "bootstrap",
    envKey: "NOJ_LLM_DEFAULT_GLOBAL_DAY_TOKENS",
    category: "other",
  },
  {
    key: "NOJ_LLM_DEFAULT_GLOBAL_DAY_COST",
    type: "integer",
    description: "LLM 配额缺失 fallback：全局日成本上限",
    is_secret: false,
    scope: "bootstrap",
    envKey: "NOJ_LLM_DEFAULT_GLOBAL_DAY_COST",
    category: "other",
  },
  {
    key: "NOJ_LLM_DEFAULT_USER_DAY_CALLS",
    type: "integer",
    description: "LLM 配额缺失 fallback：单用户日调用上限",
    is_secret: false,
    scope: "bootstrap",
    envKey: "NOJ_LLM_DEFAULT_USER_DAY_CALLS",
    category: "other",
  },
  {
    key: "NOJ_LLM_DEFAULT_USER_DAY_TOKENS",
    type: "integer",
    description: "LLM 配额缺失 fallback：单用户日 token 上限",
    is_secret: false,
    scope: "bootstrap",
    envKey: "NOJ_LLM_DEFAULT_USER_DAY_TOKENS",
    category: "other",
  },
  {
    key: "NOJ_LLM_DEFAULT_USER_DAY_COST",
    type: "integer",
    description: "LLM 配额缺失 fallback：单用户日成本上限",
    is_secret: false,
    scope: "bootstrap",
    envKey: "NOJ_LLM_DEFAULT_USER_DAY_COST",
    category: "other",
  },
  {
    key: "NOJ_LLM_DEFAULT_PROBLEM_DAY_CALLS",
    type: "integer",
    description: "LLM 配额缺失 fallback：单题日调用上限",
    is_secret: false,
    scope: "bootstrap",
    envKey: "NOJ_LLM_DEFAULT_PROBLEM_DAY_CALLS",
    category: "other",
  },
  {
    key: "NOJ_LLM_DEFAULT_PROBLEM_DAY_TOKENS",
    type: "integer",
    description: "LLM 配额缺失 fallback：单题日 token 上限",
    is_secret: false,
    scope: "bootstrap",
    envKey: "NOJ_LLM_DEFAULT_PROBLEM_DAY_TOKENS",
    category: "other",
  },
  {
    key: "NOJ_LLM_DEFAULT_PROBLEM_DAY_COST",
    type: "integer",
    description: "LLM 配额缺失 fallback：单题日成本上限",
    is_secret: false,
    scope: "bootstrap",
    envKey: "NOJ_LLM_DEFAULT_PROBLEM_DAY_COST",
    category: "other",
  },
  // ── OAuth（第三方登录）─────────────────────────────────────
  {
    key: "OAUTH_GITHUB_CLIENT_ID",
    type: "string",
    description: "GitHub OAuth Client ID",
    is_secret: false,
    scope: "bootstrap",
    envKey: "OAUTH_GITHUB_CLIENT_ID",
    category: "auth",
  },
  {
    key: "OAUTH_GITHUB_CLIENT_SECRET",
    type: "string",
    description: "GitHub OAuth Client Secret",
    is_secret: true,
    scope: "bootstrap",
    envKey: "OAUTH_GITHUB_CLIENT_SECRET",
    category: "auth",
  },
  {
    key: "OAUTH_OIDC_ISSUER_URL",
    type: "string",
    description: "OIDC Issuer URL",
    is_secret: false,
    scope: "bootstrap",
    envKey: "OAUTH_OIDC_ISSUER_URL",
    category: "auth",
  },
  {
    key: "OAUTH_OIDC_CLIENT_ID",
    type: "string",
    description: "OIDC Client ID",
    is_secret: false,
    scope: "bootstrap",
    envKey: "OAUTH_OIDC_CLIENT_ID",
    category: "auth",
  },
  {
    key: "OAUTH_OIDC_CLIENT_SECRET",
    type: "string",
    description: "OIDC Client Secret",
    is_secret: true,
    scope: "bootstrap",
    envKey: "OAUTH_OIDC_CLIENT_SECRET",
    category: "auth",
  },
  {
    key: "OAUTH_OIDC_NAME",
    type: "string",
    description: "OIDC 展示名称（默认 OIDC）",
    is_secret: false,
    scope: "bootstrap",
    envKey: "OAUTH_OIDC_NAME",
    category: "auth",
  },
  // ── 开发/测试专用（visible:false，仅参与校验不展示）────────
  {
    key: "NOJ_RUN_E2E",
    type: "boolean",
    description: "E2E 模式开关（NOJ_RUN_E2E=1 时跳过引导管理员种子）",
    is_secret: false,
    scope: "bootstrap",
    envKey: "NOJ_RUN_E2E",
    category: "other",
    visible: false,
  },
  {
    key: "TEST_SCHEMA",
    type: "string",
    description: "测试隔离 schema（search_path 分片）",
    is_secret: false,
    scope: "bootstrap",
    envKey: "TEST_SCHEMA",
    category: "other",
    visible: false,
  },
  {
    key: "NOJ_MIGRATIONS_DIR",
    type: "string",
    description: "迁移文件目录覆盖",
    is_secret: false,
    scope: "bootstrap",
    envKey: "NOJ_MIGRATIONS_DIR",
    category: "other",
    visible: false,
  },
  {
    key: "NOJ_BYPASS_JWT_REVOKE",
    type: "boolean",
    description: "跳过 JWT 吊销检查（仅开发调试）",
    is_secret: false,
    scope: "bootstrap",
    envKey: "NOJ_BYPASS_JWT_REVOKE",
    category: "other",
    visible: false,
  },
] as const;

const VALID_TYPES: readonly SettingType[] = [
  "boolean",
  "string",
  "text",
  "integer",
] as const;

/**
 * 启动期注册表校验：
 * - key 唯一、type 合法；
 * - scope 声明完整：bootstrap 必须有 envKey，runtime 必须有 envFallback（或无兜底）；
 * - env 键唯一：任一 env 键至多被一项声明（bootstrap envKey 或 runtime envFallback）。
 */
export function validateRegistry(): void {
  const seenKeys = new Set<string>();
  const seenEnvKeys = new Set<string>();
  for (const def of CONFIG_DEFINITIONS) {
    if (seenKeys.has(def.key)) {
      throw new Error(
        `[settings-registry] 重复的 key: ${def.key}（每个设置项 key 必须唯一）`,
      );
    }
    seenKeys.add(def.key);

    if (!VALID_TYPES.includes(def.type)) {
      throw new Error(
        `[settings-registry] 非法 type: ${def.key} -> ${def.type}（合法值: ${
          VALID_TYPES.join(", ")
        }）`,
      );
    }

    if (def.scope !== "runtime" && def.scope !== "bootstrap") {
      throw new Error(
        `[settings-registry] 非法 scope: ${def.key} -> ${def.scope}（合法值: runtime/bootstrap）`,
      );
    }

    // scope 完整性
    if (def.scope === "bootstrap" && !def.envKey) {
      throw new Error(
        `[settings-registry] bootstrap 项必须声明 envKey: ${def.key}`,
      );
    }
    if (def.scope === "runtime" && def.envKey) {
      throw new Error(
        `[settings-registry] runtime 项不应声明 envKey: ${def.key}（runtime 使用 envFallback）`,
      );
    }

    // env 键唯一性
    const envKey = def.envKey ?? def.envFallback;
    if (envKey) {
      if (seenEnvKeys.has(envKey)) {
        throw new Error(
          `[settings-registry] env 键重复声明: ${envKey}（两个设置项不能共用一个 env 变量）`,
        );
      }
      seenEnvKeys.add(envKey);
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
  return CONFIG_DEFINITIONS.find((d) => d.key === key);
}

/** 是否为 bootstrap（env-owned，启动期定型只读） */
export function isBootstrap(key: string): boolean {
  return findDefinition(key)?.scope === "bootstrap";
}

/** 是否为 runtime（DB-owned，运行时可热改） */
export function isRuntime(key: string): boolean {
  return findDefinition(key)?.scope === "runtime";
}

/** 是否在管理后台可见（visible !== false） */
export function isVisible(key: string): boolean {
  return findDefinition(key)?.visible !== false;
}
