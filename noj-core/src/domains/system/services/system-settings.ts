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

import { eq, inArray } from "drizzle-orm";
import {
  getDb,
  registerDbResetCallback,
} from "../../../shared/db/connection.ts";
import { systemSettings } from "../../../shared/db/schema.ts";
import { ValidationError } from "../../../shared/base/errors.ts";
import { logAudit } from "./audit-log.ts";
import { getEnvSnapshotValue } from "./env-snapshot.ts";
import {
  CONFIG_DEFINITIONS,
  type ConfigScope,
  findDefinition,
  isBootstrap,
  type SettingCategory,
  type SettingDefinition,
  type SettingType,
} from "../../../shared/config/settings-registry.ts";

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
  /** 生命周期归属：runtime=DB 可热改；bootstrap=env 启动期定型只读 */
  scope: ConfigScope;
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
  /** bootstrap 项在 DB 中是否存在残留旧值（被忽略，可一键清理） */
  db_orphaned?: boolean;
  /** runtime 项：对应的 env 兜底键名（envFallback） */
  env_key?: string;
  /** runtime 项：env 兜底当前是否非空存在 */
  env_present?: boolean;
  /** runtime 项：DB 是否已写入该键 */
  db_present?: boolean;
  /** runtime 项：DB 与 env 同时存在（当前 DB 值优先） */
  conflict?: boolean;
}

/** module-level 缓存：key -> 解析后的值 */
let cache: Map<string, SettingValue> = new Map();

/** 是否已执行 init（用于测试时跳过重复） */
let _initialized = false;

// 注册 DB 重置回调：TRUNCATE system_settings 表时同步清内存缓存
registerDbResetCallback(() => {
  cache = new Map();
  _initialized = false;
});

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
    // bootstrap（env-owned）项忽略 DB 旧值：不缓存，读取走 env 快照
    if (isBootstrap(row.key)) continue;

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
 * 读单条：按 scope 分支。
 * - runtime：DB → env 兜底 → registry.default 兜底链；
 *   - DB 命中：source='db'，返回 DB 值
 *   - DB miss + env 命中：source='env'，返回 env 值
 *   - DB miss + env miss + default 存在：source='default'，返回 default
 * - bootstrap：env 快照 → default（不读 DB，DB 残留旧值忽略）；
 *   - env 命中：source='env'，返回 env 值（按 type 解析）
 *   - env miss + default 存在：source='default'
 *   - 都不存在：返回 null
 */
export function getSetting(key: string): SettingValue | null {
  const def = findDefinition(key);

  // bootstrap（env-owned）：跳过 DB 缓存，直接读 env 快照
  if (def?.scope === "bootstrap") {
    return getSettingFromEnv(def);
  }

  // 1. DB 缓存
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }

  // 2. env 兜底
  // envFallback 是注册表里声明的键名（与 key 可能不同）
  if (def) {
    return getSettingFromEnv(def) ?? fallbackToDefault(def);
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

/** 从 env 快照读取（按注册表 type 解析），env 未设置时返回 null */
function getSettingFromEnv(
  def: SettingDefinition,
): SettingValue | null {
  const envKey = def.scope === "bootstrap" ? def.envKey! : def.envFallback!;
  // 优先走启动期快照（性能最优），快照中不存在时回退到实时 Deno.env.get
  // （兼容测试/运维中环境变量在快照后设置或未进入快照白名单的场景）
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
  return null;
}

/** 回退到注册表 default（无 default 时返回 null） */
function fallbackToDefault(def: SettingDefinition): SettingValue | null {
  if (def.default === undefined) return null;
  return {
    value: def.default,
    raw: JSON.stringify(def.default),
    source: "default",
    updatedAt: null,
    updatedBy: null,
  };
}

/**
 * 列出所有可见配置项（runtime + bootstrap）。
 * 敏感字段在 effective_value 位置返回掩码后的字符串。
 *
 * - runtime：getSetting()（DB → env 兜底 → default），必返回；
 * - bootstrap：env 快照（未设置时返回 null 值、source=default，后台显示"未配置"）。
 */
export async function listSettings(): Promise<SystemSettingListItem[]> {
  const items: SystemSettingListItem[] = [];

  // 预取 bootstrap 残留行（key 集合），用于标记 db_orphaned
  const orphans = await listOrphanedBootstrapRows();
  const orphanedKeys = new Set(orphans.map((r) => r.key));

  for (const def of CONFIG_DEFINITIONS) {
    if (def.visible === false) continue; // 开发/测试专用键不展示

    if (def.scope === "runtime") {
      const val = getSetting(def.key);
      if (!val) continue; // 不应发生（registry default 兜底）

      // 后端脱敏：敏感字段在 API 响应中不暴露完整内容
      const sanitized = def.is_secret ? maskSecret(val.value) : val.value;
      const rawSanitized = def.is_secret ? JSON.stringify(sanitized) : val.raw;

      const envPresent = def.envFallback
        ? getSettingFromEnv(def) !== null
        : false;
      const dbPresent = val.source === "db";

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
        scope: def.scope,
        min: def.min,
        max: def.max,
        needsRestart: def.needsRestart,
        env_key: def.envFallback,
        env_present: envPresent,
        db_present: dbPresent,
        conflict: dbPresent && envPresent,
      });
      continue;
    }

    // bootstrap：读 env 快照（envKey），未设置也返回（显示"未配置"）
    const envVal = getEnvSnapshotValue(def.envKey!);

    // 后端脱敏：敏感值不在 API 响应中暴露完整内容
    let sanitized: unknown;
    let rawSanitized: string;
    if (envVal === undefined) {
      sanitized = null;
      rawSanitized = "null";
    } else if (URL_CREDENTIAL_KEYS.has(def.key)) {
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
      type: def.type,
      effective_value: sanitized,
      raw_value: rawSanitized,
      source: envVal === undefined ? "default" : "env",
      is_secret: def.is_secret,
      description: def.description,
      updated_at: null,
      updated_by: null,
      category: def.category,
      scope: def.scope,
      db_orphaned: orphanedKeys.has(def.key),
    });
  }

  return items;
}

// ─── runtime env/DB 共存检测 ────────────────────────────────

/** 单条 runtime 共存冲突信息（不包含值，避免敏感信息泄露） */
export interface RuntimeEnvConflict {
  key: string;
  envKey: string;
}

/**
 * 检测 runtime 项 DB 与 env 兜底同时存在的情况。
 *
 * 语义：DB 有写入值且 envFallback 非空时，当前实际生效的是 DB 值，
 * env 被完全遮蔽，容易造成“改了 .env 不生效”的歧义。
 * 仅用于启动日志与后台提示，不改变任何读取/写入行为。
 */
export function listRuntimeEnvConflicts(): RuntimeEnvConflict[] {
  const conflicts: RuntimeEnvConflict[] = [];
  for (const def of CONFIG_DEFINITIONS) {
    if (def.scope !== "runtime" || def.visible === false) continue;
    if (!def.envFallback) continue;
    if (!cache.has(def.key)) continue;
    if (getSettingFromEnv(def) !== null) {
      conflicts.push({ key: def.key, envKey: def.envFallback });
    }
  }
  return conflicts;
}

// ─── 写路径 ─────────────────────────────────────────────────

/**
 * 更新设置（UPSERT）。新值写入 DB，失效缓存，异步 reload。
 *
 * 可选 `tx` 参数：传入事务时仅执行校验 + 事务内 UPSERT，
 * 跳过缓存刷新与逐条审计（由调用方在事务提交后统一刷新，避免半途失败留下部分状态）。
 *
 * @throws {ValidationError} key 未注册 / 类型错 / 长度超限 / email 格式错
 */
export async function updateSetting(
  key: string,
  value: unknown,
  actorId: string,
  // tx: 可选 Drizzle 事务实例（与既有 service 惯例一致）。传入时仅执行
  // 校验 + 事务内 UPSERT，缓存刷新与逐条审计由调用方在提交后统一处理。
  // deno-lint-ignore no-explicit-any
  tx?: any,
): Promise<SystemSettingListItem> {
  // bootstrap（env-owned）项不可经后台写入：配置归 .env 管理，改后需重启
  if (isBootstrap(key)) {
    throw new ValidationError(
      `${key} 由环境变量管理（bootstrap），请修改 .env 后重启 noj-core`,
    );
  }

  const validation = validateValueType(key, value);
  if (!validation.ok) {
    throw new ValidationError(validation.message);
  }

  const now = new Date().toISOString();
  const db = tx ?? getDb();

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

  // 事务模式：缓存刷新与审计由调用方在提交后统一处理
  if (tx) {
    const def = findDefinition(key);
    if (!def) {
      throw new ValidationError(`未注册的设置项: ${key}`);
    }
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
      scope: def.scope,
    };
  }

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
    scope: def.scope,
  };
}

/**
 * 重置设置（DELETE）。从 DB 删除该 key，回退到 env/default 兜底。
 *
 * 幂等（spec 要求）：
 * - 仅接受已注册的设置项；已注册但 DB 中无该行也正常返回（DELETE 永远不会失败）
 * - 未注册 key 抛 ValidationError：未注册 key 无 env/default 兜底，删除是
 *   无效操作，且可能破坏内部状态（如删除 `rbac_sensitive_field_permissions_seeded`
 *   标记会导致敏感字段收紧授权在重启后被 seed 恢复）
 * - 缓存条目清理后，下次读取会走 env/default 兜底链
 */
export async function resetSetting(
  key: string,
  _actorId: string,
): Promise<void> {
  const db = getDb();

  // 安全约束：与 updateSetting 的 validateValueType 行为一致，仅允许已注册 key。
  if (!findDefinition(key)) {
    throw new ValidationError(`未注册的设置项: ${key}`);
  }

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
export async function reloadSingleKey(key: string): Promise<void> {
  const db = getDb();
  const rows = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.key, key))
    .limit(1);
  if (rows.length === 0) {
    // DB 无该行（如事务中新增后未提交时查询不到），清空缓存回退兜底链
    cache.delete(key);
    return;
  }

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

// ─── bootstrap 残留 DB 行处理 ───────────────────────────────

/**
 * 列出 bootstrap（env-owned）项在 DB 中的残留行。
 * 这些行已不参与取值（读取走 env），仅用于启动日志提示与后台"清理残留"。
 */
export async function listOrphanedBootstrapRows(): Promise<
  { key: string; updated_at: string | null; updated_by: string | null }[]
> {
  const db = getDb();
  const bootstrapKeys = CONFIG_DEFINITIONS
    .filter((d) => d.scope === "bootstrap")
    .map((d) => d.key);
  if (bootstrapKeys.length === 0) return [];

  return await db
    .select({
      key: systemSettings.key,
      updated_at: systemSettings.updated_at,
      updated_by: systemSettings.updated_by,
    })
    .from(systemSettings)
    .where(inArray(systemSettings.key, bootstrapKeys));
}

/**
 * 清理单条 bootstrap 残留 DB 行（DELETE system_settings）。
 * 幂等：DB 无该行也正常返回。审计记录 settings.reset。
 */
export async function cleanupBootstrapRow(
  key: string,
  _actorId: string,
): Promise<void> {
  const def = findDefinition(key);
  if (!def || def.scope !== "bootstrap") {
    throw new ValidationError(
      `仅可清理 bootstrap（环境变量管理）配置项: ${key}`,
    );
  }

  const db = getDb();
  // 取 DB 残留旧值用于审计
  const rows = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.key, key))
    .limit(1);
  const oldRaw = rows.length > 0 ? rows[0].value : undefined;

  await db.delete(systemSettings).where(eq(systemSettings.key, key));
  cache.delete(key);

  if (rows.length > 0) {
    const fromValue = def.is_secret ? maskSecret(oldRaw) : oldRaw;
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
}
