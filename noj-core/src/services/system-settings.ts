/**
 * 系统设置服务层（issue #99）。
 *
 * 提供：
 * - initSystemSettings()：启动期从 DB 全量加载到内存 Map
 * - getSetting(key)：DB → env → default 兜底链，返回 SettingValue
 * - listSettings()：合并 DB-backed 与 env-only，返回展示列表
 * - updateSetting(key, value, actorId)：UPSERT + 失效缓存 + 审计日志
 * - resetSetting(key)：DELETE + 失效缓存 + 审计日志
 *
 * 缓存策略：
 * - 启动期一次性 SELECT 全表 → Map
 * - 写路径同步失效单条 → 异步 reload
 * - 读路径 O(1) Map 查找，不打 DB
 *
 * 审计日志：已迁移至 logAudit()（issue #101）。
 */

import { eq } from "drizzle-orm";
import { getDb } from "../db/connection.ts";
import { systemSettings } from "../db/schema.ts";
import { ValidationError } from "../lib/errors.ts";
import { logAudit } from "./audit-log.ts";
import {
  ENV_ONLY_DEFINITIONS,
  getEnvSnapshotValue,
} from "../lib/env-snapshot.ts";
import {
  findDefinition,
  SETTING_DEFINITIONS,
  type SettingCategory,
  type SettingType,
} from "../lib/settings-registry.ts";

/** 单条设置项的解析后值（含来源溯源） */
export interface SettingValue {
  /** 解码后的实际值（按注册表 type 解析） */
  value: unknown;
  /** 原始 JSON 编码字符串 */
  raw: string;
  /** 值来源：DB 写入 / env 兜底 / 注册表 default */
  source: "db" | "env" | "default";
  /** ISO 8601，DB 写入时间（env/default 时为 null） */
  updatedAt: string | null;
  /** DB 写入人 userId（env/default 时为 null） */
  updatedBy: string | null;
}

/** 列表响应的单条 DTO（管理后台用，含元数据 + 敏感字段掩码） */
export interface SystemSettingListItem {
  key: string;
  type: SettingType;
  /** 掩码后的值（is_secret=true 时显示 abc***xyz） */
  effective_value: unknown;
  /** 原始 JSON 编码字符串（调试用，前端不展示明文） */
  raw_value: string;
  source: "db" | "env" | "default";
  is_secret: boolean;
  description: string;
  updated_at: string | null;
  updated_by: string | null;
  category: SettingCategory;
  /** integer 类型专用：最小值（含） */
  min?: number;
  /** integer 类型专用：最大值（含） */
  max?: number;
  /** 修改后需重启 noj-core 才能生效 */
  needsRestart?: boolean;
}

/** module-level 缓存：key -> 解析后的值 */
let cache: Map<string, SettingValue> = new Map();

/** 是否已执行 init（用于测试时跳过重复） */
let _initialized = false;

// ─── 敏感字段掩码 ───────────────────────────────────────────

/**
 * 敏感字段掩码：保留前 3 后 3 字符，中间 `***`。
 * - 长度 ≤ 6 的值整体掩码为 `***`
 * - 空字符串保持空（不算 secret）
 * - 非字符串值先 JSON.stringify 再掩码
 */
export function maskSecret(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = typeof value === "string" ? value : JSON.stringify(value);
  if (str.length === 0) return "";
  if (str.length <= 6) return "***";
  return `${str.slice(0, 3)}***${str.slice(-3)}`;
}

/** SHA-256 哈希脱敏：计算值的 SHA-256 摘要，返回 `sha256$<前16位hex>` */
export async function hashSecret(value: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(value);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = new Uint8Array(hashBuffer);
  let hex = "";
  for (let i = 0; i < hashArray.length; i++) {
    hex += hashArray[i].toString(16).padStart(2, "0");
  }
  return `sha256$${hex.slice(0, 16)}`;
}

/** URL 凭据脱敏：移除 user:password@ 部分，仅保留协议+主机+路径 */
function stripUrlCredentials(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
      return parsed.toString();
    }
    return url;
  } catch {
    // 解析失败（非标准 URL 格式），安全起见返回脱敏后的掩码
    return maskSecret(url);
  }
}

/** 敏感设置键名白名单：这些 key 在返回前端前需剥离 URL 凭据 */
const URL_CREDENTIAL_KEYS = new Set(["DATABASE_URL", "REDIS_URL"]);

// ─── 类型校验 ───────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 严格 type 校验：值必须匹配注册表 type，否则抛 ValidationError */
function validateValueType(
  key: string,
  value: unknown,
): { ok: true; raw: string } | { ok: false; message: string } {
  const def = findDefinition(key);
  if (!def) {
    return { ok: false, message: `未注册的设置项: ${key}` };
  }

  switch (def.type) {
    case "boolean": {
      if (typeof value !== "boolean") {
        return {
          ok: false,
          message: `${key} 必须是 boolean（true/false）`,
        };
      }
      return { ok: true, raw: JSON.stringify(value) };
    }
    case "string": {
      if (typeof value !== "string") {
        return { ok: false, message: `${key} 必须是 string` };
      }
      // 特定 string 类型的额外校验
      if (key === "smtp_from" && value !== "" && !EMAIL_RE.test(value)) {
        return {
          ok: false,
          message: "smtp_from 必须是有效 email 格式或空字符串",
        };
      }
      return { ok: true, raw: JSON.stringify(value) };
    }
    case "text": {
      if (typeof value !== "string") {
        return { ok: false, message: `${key} 必须是 text` };
      }
      if (value.length > 1000) {
        return {
          ok: false,
          message: `${key} 长度不能超过 1000 字符（当前 ${value.length}）`,
        };
      }
      return { ok: true, raw: JSON.stringify(value) };
    }
    case "integer": {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        return {
          ok: false,
          message: `${key} 必须是整数（integer）`,
        };
      }
      if (def.min !== undefined && value < def.min) {
        return {
          ok: false,
          message: `${key} 不能小于 ${def.min}（当前 ${value}）`,
        };
      }
      if (def.max !== undefined && value > def.max) {
        return {
          ok: false,
          message: `${key} 不能大于 ${def.max}（当前 ${value}）`,
        };
      }
      return { ok: true, raw: JSON.stringify(value) };
    }
    default:
      return { ok: false, message: `${key} 类型定义错误: ${def.type}` };
  }
}

// ─── 启动期初始化 ───────────────────────────────────────────

/**
 * 启动期初始化：从 DB 全量加载到 Map。
 * 应在 main.ts 启动顺序的"DB 迁移之后"调用一次。
 *
 * 测试环境（NOJ_ENV=test 或 PGlite 模式）也安全：DB 可能是空的，Map 为空。
 */
export async function initSystemSettings(): Promise<void> {
  if (_initialized) return;

  const db = getDb();
  const rows = await db.select().from(systemSettings);

  const newCache = new Map<string, SettingValue>();
  for (const row of rows) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(row.value);
    } catch {
      // DB 数据损坏，回退为字符串原值
      decoded = row.value;
    }
    newCache.set(row.key, {
      value: decoded,
      raw: row.value,
      source: "db",
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
    });
  }

  cache = newCache;
  _initialized = true;
}

// ─── 读路径 ─────────────────────────────────────────────────

/**
 * 读单条：DB → env → registry.default 兜底链。
 * - DB 命中：source='db'，返回 DB 值
 * - DB miss + env 命中：source='env'，返回 env 值
 * - DB miss + env miss + default 存在：source='default'，返回 default
 * - 都不存在：返回 null
 */
export function getSetting(key: string): SettingValue | null {
  // 1. DB 缓存
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }

  // 2. env 兜底
  // envFallback 是注册表里声明的键名（与 key 可能不同）
  const def = findDefinition(key);
  if (def) {
    const envKey = def.envFallback;
    // 优先走启动期快照（性能最优），快照中不存在时回退到实时 Deno.env.get
    // （兼容测试/运维中环境变量在快照后设置或未进入 ENV_ONLY_DEFINITIONS 的场景）
    const envValue = getEnvSnapshotValue(envKey) ?? Deno.env.get(envKey);
    if (envValue !== undefined && envValue !== "") {
      // 尝试按 type 解析
      let decoded: unknown = envValue;
      if (def.type === "boolean") {
        decoded = envValue === "true" || envValue === "1";
      } else if (def.type === "integer") {
        const n = parseInt(envValue, 10);
        decoded = Number.isFinite(n) ? n : envValue;
      }
      return {
        value: decoded,
        raw: JSON.stringify(decoded),
        source: "env",
        updatedAt: null,
        updatedBy: null,
      };
    }

    // 3. registry default
    return {
      value: def.default,
      raw: JSON.stringify(def.default),
      source: "default",
      updatedAt: null,
      updatedBy: null,
    };
  }

  // 非注册表 key：env 直接读
  const envVal = getEnvSnapshotValue(key);
  if (envVal !== undefined) {
    return {
      value: envVal,
      raw: JSON.stringify(envVal),
      source: "env",
      updatedAt: null,
      updatedBy: null,
    };
  }

  return null;
}

/**
 * 列出所有设置项（DB-backed 5 项 + env-only N 项）。
 * 敏感字段在 effective_value 位置返回掩码后的字符串。
 */
export async function listSettings(): Promise<SystemSettingListItem[]> {
  const items: SystemSettingListItem[] = [];

  // 1. DB-backed 设置项
  for (const def of SETTING_DEFINITIONS) {
    const val = getSetting(def.key);
    if (!val) continue; // 不应发生（registry default 兜底）

    // 后端脱敏：敏感字段在 API 响应中不暴露完整内容
    const sanitized = def.is_secret ? maskSecret(val.value) : val.value;
    const rawSanitized = def.is_secret ? JSON.stringify(sanitized) : val.raw;

    items.push({
      key: def.key,
      type: def.type,
      effective_value: sanitized,
      raw_value: rawSanitized,
      source: val.source,
      is_secret: def.is_secret,
      description: def.description,
      updated_at: val.updatedAt,
      updated_by: val.updatedBy,
      category: def.category,
      min: def.min,
      max: def.max,
      needsRestart: def.needsRestart,
    });
  }

  // 2. env-only 设置项
  for (const def of ENV_ONLY_DEFINITIONS) {
    const envVal = getEnvSnapshotValue(def.key);
    if (envVal === undefined) continue; // 未设置不展示

    // 后端脱敏：敏感值不在 API 响应中暴露完整内容
    let sanitized: string;
    let rawSanitized: string;
    if (URL_CREDENTIAL_KEYS.has(def.key)) {
      // URL 凭据：仅移除 user:password@，保留协议+主机+路径
      sanitized = stripUrlCredentials(envVal);
      rawSanitized = JSON.stringify(sanitized);
    } else if (def.key === "JWT_SECRET") {
      // JWT_SECRET 使用 SHA-256 哈希，防止暴力补全
      sanitized = await hashSecret(envVal);
      rawSanitized = JSON.stringify(sanitized);
    } else if (def.is_secret) {
      // 其他敏感字段：通用掩码
      sanitized = maskSecret(envVal);
      rawSanitized = JSON.stringify(sanitized);
    } else {
      sanitized = envVal;
      rawSanitized = JSON.stringify(envVal);
    }

    items.push({
      key: def.key,
      type: "string",
      effective_value: sanitized,
      raw_value: rawSanitized,
      source: "env",
      is_secret: def.is_secret,
      description: def.description,
      updated_at: null,
      updated_by: null,
      category: def.category,
    });
  }

  return items;
}

// ─── 写路径 ─────────────────────────────────────────────────

/**
 * 更新设置（UPSERT）。新值写入 DB，失效缓存，异步 reload。
 *
 * @throws {ValidationError} key 未注册 / 类型错 / 长度超限 / email 格式错
 */
export async function updateSetting(
  key: string,
  value: unknown,
  actorId: string,
): Promise<SystemSettingListItem> {
  const validation = validateValueType(key, value);
  if (!validation.ok) {
    throw new ValidationError(validation.message);
  }

  const now = new Date().toISOString();
  const db = getDb();

  // 获取旧值（用于审计对比）
  const oldSetting = getSetting(key);
  const fromRaw = oldSetting?.value;

  // UPSERT：PG `ON CONFLICT (key) DO UPDATE`
  await db
    .insert(systemSettings)
    .values({
      key,
      value: validation.raw,
      description: findDefinition(key)?.description ?? "",
      is_secret: findDefinition(key)?.is_secret ?? false,
      updated_at: now,
      updated_by: actorId,
    })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: {
        value: validation.raw,
        updated_at: now,
        updated_by: actorId,
      },
    });

  // 失效缓存单条，异步 reload
  cache.delete(key);
  await reloadSingleKey(key);

  // 审计日志：记录设置变更（issue #101）
  const def = findDefinition(key);
  if (!def) {
    throw new ValidationError(`未注册的设置项: ${key}`);
  }
  const fromValue = def.is_secret ? maskSecret(fromRaw) : fromRaw;
  const toValue = def.is_secret ? maskSecret(value) : value;
  await logAudit(
    "settings.update",
    {
      action: "settings.update",
      operation: "PUT",
      key,
      from: fromValue,
      to: toValue,
    },
    { type: "system_setting", id: key },
  );

  return {
    key: def.key,
    type: def.type,
    effective_value: def.is_secret ? maskSecret(value) : value,
    raw_value: validation.raw,
    source: "db",
    is_secret: def.is_secret,
    description: def.description,
    updated_at: now,
    updated_by: actorId,
    category: def.category,
  };
}

/**
 * 重置设置（DELETE）。从 DB 删除该 key，回退到 env/default 兜底。
 *
 * 幂等（spec 要求）：
 * - 即使 key 未注册或 DB 中无该行也正常返回（DELETE 永远不会失败）
 * - 缓存条目清理后，下次读取会走 env/default 兜底链
 */
export async function resetSetting(
  key: string,
  _actorId: string,
): Promise<void> {
  const db = getDb();

  // 获取旧值（用于审计对比）
  const oldSetting = getSetting(key);
  const fromRaw = oldSetting?.value;

  await db.delete(systemSettings).where(eq(systemSettings.key, key));

  cache.delete(key);
  // 重置后不需要 reload（已经从 Map 删除，下次读会走 env/default 兜底）

  // 审计日志：记录设置删除（issue #101）
  const def = findDefinition(key);
  const fromValue = def?.is_secret ? maskSecret(fromRaw) : fromRaw;
  await logAudit(
    "settings.update",
    {
      action: "settings.update",
      operation: "DELETE",
      key,
      from: fromValue,
      to: null,
    },
    { type: "system_setting", id: key },
  );
}

// ─── 内部辅助 ───────────────────────────────────────────────

/** 从 DB 重新加载单条 key 到缓存 */
async function reloadSingleKey(key: string): Promise<void> {
  const db = getDb();
  const rows = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.key, key))
    .limit(1);
  if (rows.length === 0) return;

  const row = rows[0];
  let decoded: unknown;
  try {
    decoded = JSON.parse(row.value);
  } catch {
    decoded = row.value;
  }
  cache.set(key, {
    value: decoded,
    raw: row.value,
    source: "db",
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  });
}

/** 重置缓存（仅供测试用） */
export function _resetSystemSettingsForTest(): void {
  cache = new Map();
  _initialized = false;
}
