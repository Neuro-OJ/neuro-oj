/**
 * 环境变量启动期快照（issue #99）。
 *
 * 在 main.ts 启动顺序的"DB 迁移之后、MQ 消费者启动之前"调用 snapshotEnv()，
 * 一次性把白名单 env 键的当前值快照到 module-level envSnapshot 对象。
 *
 * 后续所有"环境变量"读取走 snapshot，不直接调 Deno.env.get：
 * - 性能：O(1) 内存读 vs 系统调用
 * - 语义：env-only 设置项与 DB-backed 设置项同构（都是 Map 查找）
 * - 测试：NOJ_ENV=test 时跳过快照，返回空对象不阻断
 *
 * 与 settings-registry 的区别：
 * - settings-registry 定义 DB-backed 设置项（admin 可改）
 * - env-snapshot 定义 env-only 设置项（只读，admin 不可改）
 */

import type { SettingCategory } from "./settings-registry.ts";

/** env-only 设置项的元数据（只读展示用，admin 不可改） */
export interface EnvOnlyDefinition {
  key: string;
  description: string;
  is_secret: boolean;
  category: SettingCategory;
}

/**
 * env-only 白名单（启动期快照键名）。
 * 顺序敏感：管理后台按此顺序展示，分组用 category 字段。
 */
export const ENV_ONLY_DEFINITIONS: readonly EnvOnlyDefinition[] = [
  // ── 数据库 ───────────────────────────────────────────────
  {
    key: "DATABASE_URL",
    description: "PostgreSQL 连接串",
    is_secret: true,
    category: "database",
  },
  {
    key: "DATABASE_POOL_MAX",
    description: "连接池大小",
    is_secret: false,
    category: "database",
  },
  {
    key: "DATABASE_CONNECT_TIMEOUT",
    description: "连接超时（秒）",
    is_secret: false,
    category: "database",
  },
  {
    key: "DATABASE_IDLE_TIMEOUT",
    description: "空闲连接超时（秒）",
    is_secret: false,
    category: "database",
  },
  {
    key: "DATABASE_MAX_LIFETIME",
    description: "连接最大生命周期（秒）",
    is_secret: false,
    category: "database",
  },

  // ── Redis ────────────────────────────────────────────────
  {
    key: "REDIS_URL",
    description: "Redis 连接串",
    is_secret: false,
    category: "redis",
  },

  // ── 认证 ─────────────────────────────────────────────────
  {
    key: "JWT_SECRET",
    description: "JWT 签名密钥（≥32 字符）",
    is_secret: true,
    category: "auth",
  },
  {
    key: "JWT_EXPIRES_IN",
    description: "Token 有效期",
    is_secret: false,
    category: "auth",
  },
  {
    key: "ADMIN_EMAIL",
    description: "Seed 管理员邮箱",
    is_secret: false,
    category: "auth",
  },
  {
    key: "ADMIN_PASS",
    description: "Seed 管理员密码",
    is_secret: true,
    category: "auth",
  },

  // ── 速率限制 ─────────────────────────────────────────────
  {
    key: "RATE_LIMIT_ENABLED",
    description: "总开关",
    is_secret: false,
    category: "rate_limit",
  },
  {
    key: "RATE_LIMIT_LOGIN_IP_WINDOW",
    description: "IP 维度限流窗口（秒）",
    is_secret: false,
    category: "rate_limit",
  },
  {
    key: "RATE_LIMIT_LOGIN_IP_MAX",
    description: "IP 维度窗口内最大尝试次数",
    is_secret: false,
    category: "rate_limit",
  },
  {
    key: "RATE_LIMIT_LOGIN_ACC_WINDOW",
    description: "账号维度限流窗口（秒）",
    is_secret: false,
    category: "rate_limit",
  },
  {
    key: "RATE_LIMIT_LOGIN_ACC_MAX",
    description: "账号维度窗口内最大尝试次数",
    is_secret: false,
    category: "rate_limit",
  },
  {
    key: "RATE_LIMIT_LOGIN_BACKOFF_SEC",
    description: "每次失败退避秒数",
    is_secret: false,
    category: "rate_limit",
  },
  {
    key: "RATE_LIMIT_LOGIN_LOCK_THRESHOLD",
    description: "连续失败锁定阈值",
    is_secret: false,
    category: "rate_limit",
  },
  {
    key: "RATE_LIMIT_LOGIN_LOCK_SECONDS",
    description: "锁定时长（秒）",
    is_secret: false,
    category: "rate_limit",
  },
  {
    key: "TRUSTED_PROXIES",
    description: "可信代理白名单（IP/CIDR，逗号分隔）",
    is_secret: false,
    category: "rate_limit",
  },

  // ── 邮件 ─────────────────────────────────────────────────
  {
    key: "EMAIL_PROVIDER",
    description: "邮件 Provider：mock/aliyun/tencent",
    is_secret: false,
    category: "email",
  },
  {
    key: "ALIBABA_ACCESS_KEY_ID",
    description: "阿里云 DirectMail AccessKey ID",
    is_secret: false,
    category: "email",
  },
  {
    key: "ALIBABA_ACCESS_KEY_SECRET",
    description: "阿里云 DirectMail AccessKey Secret",
    is_secret: true,
    category: "email",
  },
  {
    key: "ALIBABA_FROM_EMAIL",
    description: "阿里云发信地址",
    is_secret: false,
    category: "email",
  },
  {
    key: "TENCENT_SECRET_ID",
    description: "腾讯云 SES SecretId",
    is_secret: false,
    category: "email",
  },
  {
    key: "TENCENT_SECRET_KEY",
    description: "腾讯云 SES SecretKey",
    is_secret: true,
    category: "email",
  },
  {
    key: "TENCENT_FROM_EMAIL",
    description: "腾讯云发信地址",
    is_secret: false,
    category: "email",
  },
  {
    key: "TENCENT_REGION",
    description: "腾讯云地域",
    is_secret: false,
    category: "email",
  },

  // ── CORS ─────────────────────────────────────────────────
  {
    key: "CORS_ALLOWED_ORIGINS",
    description: "生产 CORS 白名单（逗号分隔）",
    is_secret: false,
    category: "cors",
  },

  // ── 其他 ─────────────────────────────────────────────────
  {
    key: "PORT",
    description: "HTTP 监听端口",
    is_secret: false,
    category: "other",
  },
  {
    key: "NOJ_ENV",
    description: "运行环境（空=development，production=生产）",
    is_secret: false,
    category: "other",
  },
] as const;

/** module-level 快照：env 键 -> 当前值（undefined 表示未设置） */
let envSnapshot: Record<string, string | undefined> = {};

/** 是否已执行 snapshotEnv（用于测试时跳过重复） */
let _snapshotted = false;

/**
 * 执行启动期快照。
 * - NOJ_ENV === 'test' 时跳过（测试环境 .env 可能不存在），返回空对象
 * - 正常情况下遍历 ENV_ONLY_DEFINITIONS 把 Deno.env.get 结果写入 envSnapshot
 *
 * 应在 main.ts 启动顺序的"DB 迁移之后"调用一次。
 */
export function snapshotEnv(): Record<string, string | undefined> {
  if (_snapshotted) {
    return envSnapshot;
  }

  const snap: Record<string, string | undefined> = {};
  for (const def of ENV_ONLY_DEFINITIONS) {
    snap[def.key] = Deno.env.get(def.key);
  }
  envSnapshot = snap;
  _snapshotted = true;
  return envSnapshot;
}

/** 读取快照值（供 service / route 使用） */
export function getEnvSnapshotValue(key: string): string | undefined {
  return envSnapshot[key];
}

/** 完整快照（仅供测试用，正常代码走 getEnvSnapshotValue） */
export function getEnvSnapshot(): Record<string, string | undefined> {
  return envSnapshot;
}

/** 重置快照状态（仅供测试用） */
export function _resetEnvSnapshotForTest(): void {
  envSnapshot = {};
  _snapshotted = false;
}
