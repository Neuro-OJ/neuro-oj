/**
 * 统一配置注册表的 bootstrap 半区（env-owned 启动期定型项）。
 *
 * 从 settings-registry.ts 拆出（2026-09-13）：该文件曾达 1380 行，越过
 * `scripts/check-file-size.ts` 的 1200 行阈值并触发棘轮（禁止继续变大）。
 * 拆分的只是**数据的物理位置**，语义依旧是「单一事实源」：
 * settings-registry.ts 的 CONFIG_DEFINITIONS 按原顺序展开本数组，
 * 对外导出、条目顺序与校验行为完全不变。
 *
 * 归类：scope=bootstrap（env 唯一决定，改 .env 后需重启），
 * 含「bootstrap env-only 基础设施项」与「纯 infra/ops env」两段。
 */

import type { SettingDefinition } from "./settings-registry.ts";

/** bootstrap（env-owned）配置项元数据；顺序即对外暴露顺序。 */
export const BOOTSTRAP_CONFIG_DEFINITIONS: readonly SettingDefinition[] = [
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
  {
    key: "DATABASE_JIT",
    type: "string",
    description:
      "PostgreSQL JIT 编译（off 默认关闭；on 恢复）。OLTP 负载下退化查询触发 JIT 纯属开销",
    is_secret: false,
    scope: "bootstrap",
    envKey: "DATABASE_JIT",
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
  {
    key: "LOG_COLOR",
    type: "string",
    description:
      "日志着色（always/never/auto；NO_COLOR 优先，LOG_FORMAT=json 时恒无色）",
    is_secret: false,
    scope: "bootstrap",
    envKey: "LOG_COLOR",
    category: "other",
  },
  {
    key: "NO_COLOR",
    type: "string",
    description:
      "通用配色禁用约定（https://no-color.org）：非空即关闭着色，优先于 LOG_COLOR；空串视为未设置",
    is_secret: false,
    scope: "bootstrap",
    envKey: "NO_COLOR",
    category: "other",
  },
  // ── 可观测性 ───────────────────────────────────────────────
  {
    key: "OBSERVABILITY_SNAPSHOT_TIMEOUT_MS",
    type: "integer",
    description: "观测快照 provider 默认超时（毫秒）",
    is_secret: false,
    scope: "bootstrap",
    envKey: "OBSERVABILITY_SNAPSHOT_TIMEOUT_MS",
    category: "other",
  },
  {
    key: "OBSERVABILITY_CACHE_TTL_MS",
    type: "integer",
    description: "观测快照/健康探针短缓存 TTL（毫秒）",
    is_secret: false,
    scope: "bootstrap",
    envKey: "OBSERVABILITY_CACHE_TTL_MS",
    category: "other",
  },
  {
    key: "OBSERVABILITY_MAX_SERIES",
    type: "integer",
    description: "单指标最大序列数（防止高基数打爆 Prometheus）",
    is_secret: false,
    scope: "bootstrap",
    envKey: "OBSERVABILITY_MAX_SERIES",
    category: "other",
  },
  {
    key: "RUNTIME_LLM_GATEWAY_URL",
    type: "string",
    description: "LLM 网关内部健康/指标地址",
    is_secret: false,
    scope: "bootstrap",
    envKey: "RUNTIME_LLM_GATEWAY_URL",
    category: "other",
  },
  {
    key: "RUNTIME_JUDGE_MODE",
    type: "string",
    description: "Judge 观测模式（heartbeat/http）",
    is_secret: false,
    scope: "bootstrap",
    envKey: "RUNTIME_JUDGE_MODE",
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
  // 注：NOJ_LLM_DEFAULT_* 配额 env 已迁至 noj-llm-gateway（issue #497）。
  // 它们由网关的 fallbackQuota() 消费，登记在 core 注册表会误导运维
  // （在 core 后台可见、却要重启 gateway 才生效）。声明见
  // noj-llm-gateway/src/config-registry.ts，由 check:config-usage 跨服务校验。
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
    // issue #499：这是 OAUTH_GITHUB_CLIENT_SECRET 的历史别名，此前未登记，
    // 属于「代码在读、注册表没有」的盲区（后台不可见、check-env 不校验）。
    // 保留而非删除，是为了避免已使用该别名的部署在升级后**静默**失去 GitHub 登录
    // （两个名字指向同一密钥）；新部署请一律使用 OAUTH_GITHUB_CLIENT_SECRET。
    key: "OAUTH_GITHUB_SECRET",
    type: "string",
    description:
      "【已废弃别名】GitHub OAuth Client Secret 的旧名，仅向后兼容；新部署请使用 OAUTH_GITHUB_CLIENT_SECRET",
    is_secret: true,
    scope: "bootstrap",
    envKey: "OAUTH_GITHUB_SECRET",
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
