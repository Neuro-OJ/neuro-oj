import { sql } from "drizzle-orm";
import postgres from "postgres";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import * as schema from "./schema.ts";
import { ALL_TABLES, SCHEMA_DDL, SCHEMA_INDEXES } from "./schema-ddl.ts";
import { dirname, resolve } from "jsr:@std/path@^1";
import { logger } from "./../shared/base/logging.ts";

let _db: ReturnType<typeof drizzlePg> | null = null;
let _client: ReturnType<typeof postgres> | null = null;

/** PGlite 全局单例——测试模式下使用，生产环境/CI 保持 null */
let _pgliteInstance: PGlite | null = null;
/** PGlite Schema 引导 Promise——首次 resetDbForTest() 时执行 */
let _bootstrapPromise: Promise<void> | null = null;
/** 当前 PGlite 实例是否从预构建模板加载（避免重复 DDL） */
let _pgliteTemplateLoaded = false;

/** 模板缓存格式版本；PGlite 依赖大版本升级时 +1 */
const PGLITE_TEMPLATE_FORMAT = 1;
const TEMPLATE_CACHE_DIR = resolve(
  dirname(new URL(import.meta.url).pathname),
  "../../.test-cache",
);
const PGLITE_TEMPLATE_FILE = resolve(TEMPLATE_CACHE_DIR, "pglite-template.tgz");
const PGLITE_TEMPLATE_HASH_FILE = resolve(
  TEMPLATE_CACHE_DIR,
  "pglite-template.hash",
);

/** reset 默认清空全部表（含 RBAC 种子表），随后重新播种，保证无 preload 时也干净 */
const RESET_TABLES = [...ALL_TABLES] as string[];

// ── 测试事务回滚隔离 ────────────────────────────────────────

type DbClient = ReturnType<typeof drizzlePg>;

type TestTransactionState =
  | { status: "idle" }
  | { status: "pending" }
  | {
    status: "active";
    db: DbClient;
    rawDb: DbClient;
    rollback: () => Promise<void>;
  };

let _testTransactionState: TestTransactionState = { status: "idle" };
let _testTransactionDisabled = false;
let _savepointSeq = 0;
let _testTransactionProxy: DbClient | null = null;

/**
 * DB 重置回调（避免循环依赖：其他模块注册清理回调，resetDbForTest 调用）。
 * 解决 system_settings 等模块的内存缓存与 DB TRUNCATE 不同步导致的测试污染。
 */
const _onDbResetCallbacks: Array<() => void> = [];

/** 注册测试重置回调（供 system-settings 等模块注册缓存清理函数） */
export function registerDbResetCallback(fn: () => void): void {
  _onDbResetCallbacks.push(fn);
}

// ── PGlite 模板缓存 ──────────────────────────────────────────

/**
 * 计算 PGlite 模板内容 hash。
 *
 * 参与 hash 的输入包括 schema DDL、索引 DDL、RBAC/社区种子源码以及模板格式
 * 版本，确保 DDL 或种子逻辑变化后模板自动失效。
 */
export async function computePGliteTemplateHash(): Promise<string> {
  const here = dirname(new URL(import.meta.url).pathname);
  const sourceFiles = [
    resolve(here, "schema-ddl.ts"),
    resolve(here, "../domains/system/services/seed/seed-rbac.ts"),
    resolve(here, "../domains/community/services/community/community-seed.ts"),
  ];
  const parts = [String(PGLITE_TEMPLATE_FORMAT)];
  for (const file of sourceFiles) {
    parts.push(await Deno.readTextFile(file));
  }
  const data = new TextEncoder().encode(parts.join("\n---\n"));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** 同步读取当前模板文件；不存在时返回 null */
export function loadPGliteTemplateBytesSync(): Uint8Array | null {
  try {
    return Deno.readFileSync(PGLITE_TEMPLATE_FILE);
  } catch {
    return null;
  }
}

/**
 * 构建 PGlite 模板数据。
 *
 * 通过临时替换全局单例复用现有 schema 引导与种子逻辑，保证模板内容与
 * `ensurePGliteSchemaForTest()` 完全一致。
 */
export async function buildPGliteTemplateData(): Promise<Uint8Array> {
  const pg = new PGlite();
  const prevInstance = _pgliteInstance;
  const prevDb = _db;
  const prevBootstrap = _bootstrapPromise;
  const prevTemplateLoaded = _pgliteTemplateLoaded;

  _pgliteInstance = pg;
  _db = null;
  _bootstrapPromise = null;
  _pgliteTemplateLoaded = false;

  try {
    await ensurePGliteSchemaForTest();
    const blob = await pg.dumpDataDir();
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    _pgliteInstance = prevInstance;
    _db = prevDb;
    _bootstrapPromise = prevBootstrap;
    _pgliteTemplateLoaded = prevTemplateLoaded;
    await pg.close().catch(() => {});
  }
}

/**
 * 确保模板缓存存在且与当前 schema/种子一致；返回模板文件路径。
 * 若模板缺失或 hash 不匹配则自动重建。
 */
export async function ensurePGliteTemplateCached(): Promise<string> {
  const hash = await computePGliteTemplateHash();
  const expectedHashFile = hash;
  let currentHash = "";
  try {
    currentHash = await Deno.readTextFile(PGLITE_TEMPLATE_HASH_FILE);
  } catch {
    // 无 hash 文件，视为过期
  }
  if (currentHash === expectedHashFile) {
    try {
      await Deno.stat(PGLITE_TEMPLATE_FILE);
      return PGLITE_TEMPLATE_FILE;
    } catch {
      // 模板文件缺失，继续重建
    }
  }

  const bytes = await buildPGliteTemplateData();
  await Deno.mkdir(TEMPLATE_CACHE_DIR, { recursive: true });
  await Deno.writeFile(PGLITE_TEMPLATE_FILE, bytes);
  await Deno.writeTextFile(PGLITE_TEMPLATE_HASH_FILE, expectedHashFile);
  return PGLITE_TEMPLATE_FILE;
}

/** 尝试从模板创建 PGlite 实例；无模板时返回 null */
function createPGliteInstanceFromTemplate(): PGlite | null {
  const bytes = loadPGliteTemplateBytesSync();
  if (!bytes) return null;
  _pgliteTemplateLoaded = true;
  return new PGlite({ loadDataDir: new Blob([bytes as unknown as BlobPart]) });
}

/**
 * 判断当前是否为 PGlite 模式（无 DATABASE_URL 时自动启用）。
 *
 * 安全修复 NOJ-032：仅测试/未显式声明环境的进程允许 PGlite 兜底。
 * 显式声明了非 test 环境（如 production/staging）时，缺少 DATABASE_URL
 * 直接失败，避免生产静默降级到内存数据库导致数据丢失。
 */
function isPGliteMode(): boolean {
  if (Deno.env.get("DATABASE_URL")) return false;

  const nojEnv = Deno.env.get("NOJ_ENV");
  if (nojEnv && nojEnv !== "test") {
    throw new Error(
      `NOJ_ENV=${nojEnv} 且未配置 DATABASE_URL。` +
        "非测试环境必须显式配置外部 PostgreSQL，拒绝静默降级到 PGlite 内存数据库。",
    );
  }
  return true;
}

// ── 测试事务回滚隔离：Savepoint 代理 ─────────────────────────

/**
 * 创建测试事务 db 代理。
 *
 * 只拦截 `transaction`，将其转成 SAVEPOINT；其余方法全部委托给真实事务 db。
 */
function createTestTransactionDb(realDb: DbClient): DbClient {
  const proxy = new Proxy(realDb, {
    get(target, prop, _receiver) {
      if (prop === "transaction") {
        return savepointTransaction;
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  _testTransactionProxy = proxy as unknown as DbClient;
  return proxy as unknown as DbClient;
}

/**
 * 在测试事务内模拟嵌套事务：SAVEPOINT / RELEASE / ROLLBACK TO。
 */
async function savepointTransaction(
  callback: (tx: DbClient) => unknown,
  _config?: unknown,
): Promise<unknown> {
  const state = _testTransactionState;
  if (state.status !== "active") {
    throw new Error("savepointTransaction 只能在 active 测试事务内调用");
  }
  const db = state.rawDb;
  const name = `noj_sp_${_savepointSeq++}`;
  await db.execute(sql`SAVEPOINT ${sql.raw(name)}`);
  try {
    const result = await callback(_testTransactionProxy!);
    await db.execute(sql`RELEASE SAVEPOINT ${sql.raw(name)}`);
    return result;
  } catch (err) {
    await db.execute(sql`ROLLBACK TO SAVEPOINT ${sql.raw(name)}`);
    await db.execute(sql`RELEASE SAVEPOINT ${sql.raw(name)}`);
    throw err;
  }
}

/**
 * 真正开启测试事务（由 beginTestTransaction 在 DB 已初始化时调用）。
 *
 * PGlite：在现有实例上 BEGIN。
 * PG：创建 max:1 专用连接并 BEGIN。
 */
async function startRealTransaction(): Promise<void> {
  if (_testTransactionState.status !== "pending") return;

  if (isPGliteMode()) {
    if (!_pgliteInstance) return; // DB 尚未初始化，保持 pending
    await _pgliteInstance.query("BEGIN");
    const realDb = getDb();
    const proxy = createTestTransactionDb(realDb);
    _savepointSeq = 0;
    _testTransactionState = {
      status: "active",
      db: proxy,
      rawDb: realDb,
      rollback: async () => {
        await _pgliteInstance!.query("ROLLBACK");
      },
    };
    return;
  }

  // PG 模式：测试模式连接池为 max:1，直接在同一连接上 BEGIN
  if (!_client) return; // DB 尚未初始化，保持 pending
  const realDb = getDb();
  await realDb.execute(sql`BEGIN`);
  const proxy = createTestTransactionDb(realDb);
  _savepointSeq = 0;
  _testTransactionState = {
    status: "active",
    db: proxy,
    rawDb: realDb,
    rollback: async () => {
      await realDb.execute(sql`ROLLBACK`);
    },
  };
}

/**
 * 测试用例开始：进入 pending；若 DB 已初始化则立即开启真实事务。
 */
export async function beginTestTransaction(): Promise<void> {
  if (_testTransactionDisabled) return;
  if (_testTransactionState.status !== "idle") return;
  _testTransactionState = { status: "pending" };
  await startRealTransaction();
}

/**
 * 测试用例结束：回滚 active 事务并清理，或直接回到 idle。
 */
export async function rollbackTestTransaction(): Promise<void> {
  const state = _testTransactionState;
  _testTransactionProxy = null;
  if (state.status === "active") {
    try {
      await state.rollback();
    } finally {
      _testTransactionState = { status: "idle" };
    }
    return;
  }
  _testTransactionState = { status: "idle" };
}

/** 当前是否处于 active 测试事务中 */
export function isInsideTestTransaction(): boolean {
  return _testTransactionState.status === "active";
}

/** 当前文件是否通过 disableTestTransactionForFile() 关闭了事务包装 */
export function isTestTransactionDisabled(): boolean {
  return _testTransactionDisabled;
}

/**
 * 文件级 opt-out：存在跨用例数据依赖的测试文件调用此函数后，
 * 该文件所有用例跳过事务包装。
 */
export function disableTestTransactionForFile(): void {
  _testTransactionDisabled = true;
}

/**
 * 获取 Drizzle ORM 数据库实例（单例模式）。
 *
 * 双模式驱动：
 * - `DATABASE_URL` 已设置 → postgres.js 连接外部 PostgreSQL（生产/CI）
 * - `DATABASE_URL` 未设置 → PGlite 内存 PostgreSQL（测试，零外部依赖）
 */
export function getDb() {
  if (_testTransactionState.status === "active") {
    return _testTransactionState.db;
  }

  if (_db) return _db;

  if (isPGliteMode()) {
    // PGlite 模式：全局单例，首次调用时优先从模板加载
    if (!_pgliteInstance) {
      _pgliteInstance = createPGliteInstanceFromTemplate() ?? new PGlite();
    }
    _db = drizzlePglite(
      _pgliteInstance,
      { schema },
    ) as unknown as ReturnType<typeof drizzlePg>;
    return _db;
  }

  const databaseUrl = Deno.env.get("DATABASE_URL");
  if (!databaseUrl) {
    throw new Error("环境变量 DATABASE_URL 未设置");
  }

  try {
    const poolMax = parseInt(Deno.env.get("DATABASE_POOL_MAX") || "10", 10);
    // 测试模式使用单连接，确保模块级捕获的 db 与测试事务在同一连接上，
    // 避免 HTTP 请求（事务内）与测试直接 db 操作（全局池）跨连接不可见。
    const isTestMode = Deno.env.get("NOJ_ENV") === "test" ||
      !!Deno.env.get("TEST_SCHEMA");
    const connectTimeout = parseInt(
      Deno.env.get("DATABASE_CONNECT_TIMEOUT") || "10",
      10,
    );
    const idleTimeout = parseInt(
      Deno.env.get("DATABASE_IDLE_TIMEOUT") || "300",
      10,
    );
    const maxLifetime = parseInt(
      Deno.env.get("DATABASE_MAX_LIFETIME") || "3600",
      10,
    );
    // TEST_SCHEMA：测试并行分片时每个 worker 进程指向独立的 PG schema，
    // 使 resetDbForTest() 的 TRUNCATE 只影响本分片（进程间互不干扰）。
    // 通过 libpq 的 startup 参数 `-csearch_path=...` 在每个物理连接建立时
    // 生效（postgres.js 的 connection.options 传入 PG startup packet，
    // 服务端作为 GUC 命令处理），保证连接池内所有连接（含 Drizzle migrator
    // 使用的连接）都落在目标 schema；未限定表名按 search_path 解析，
    // CREATE TABLE / TRUNCATE / SELECT 均自动隔离。
    const testSchema = Deno.env.get("TEST_SCHEMA") || "";
    if (testSchema && !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(testSchema)) {
      throw new Error(
        `TEST_SCHEMA 非法: ${testSchema}（仅允许 SQL 标识符，防止 search_path 注入）`,
      );
    }
    _client = postgres(databaseUrl, {
      max: isTestMode ? 1 : poolMax,
      connect_timeout: connectTimeout,
      idle_timeout: idleTimeout,
      max_lifetime: maxLifetime,
      // 附带 public 兜底：系统/扩展对象（如 pg_trgm 运算符）仍可解析
      connection: testSchema
        ? { options: `-csearch_path=${testSchema},public` }
        : undefined,
    });
    _db = drizzlePg(_client, { schema });
    return _db;
  } catch (err) {
    logger.error("数据库初始化失败", { err });
    throw err;
  }
}

/**
 * 检查数据库连接状态。
 * PGlite 模式检查实例是否已初始化；postgres.js 模式执行 SELECT 1 验证。
 */
export async function checkDbHealth(): Promise<
  { ok: boolean; error?: string }
> {
  if (isPGliteMode()) {
    if (!_db) {
      return { ok: false, error: "未初始化" };
    }
    try {
      await _db.execute(sql`SELECT 1`);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }

  if (!_client) {
    return { ok: false, error: "未初始化" };
  }
  if (!_db) {
    return { ok: false, error: "未初始化" };
  }

  try {
    await _db.execute(sql`SELECT 1`);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

/**
 * 重置数据库连接状态（测试用）。
 *
 * PGlite 模式：TRUNCATE 所有表 + re-seed root 用户和 judge image。
 * 保留 PGlite 实例（不清除），避免冷启动开销。
 *
 * postgres.js 模式：关闭连接池后清空单例（现有行为不变）。
 */
/**
 * PGlite 模式：确保实例已初始化并完成 Schema 引导 + 基础种子（幂等）。
 *
 * deno test 每个测试文件独立模块图，PGlite 单例与 bootstrap 不跨文件共享；
 * 依赖 DB 的 helper（如 createUserToken）必须先调用本函数，否则表不存在。
 */
export async function ensurePGliteSchemaForTest(): Promise<void> {
  if (!isPGliteMode()) return;
  if (!_pgliteInstance) {
    _pgliteInstance = createPGliteInstanceFromTemplate() ?? new PGlite();
  }
  await _pgliteInstance.waitReady;
  // 从模板加载时 schema 已存在，无需重复执行 DDL
  if (!_pgliteTemplateLoaded) {
    // 自动引导 Schema（首次调用时），await 确保引导完成
    if (!_bootstrapPromise) {
      _bootstrapPromise = (async () => {
        for (const ddl of SCHEMA_DDL) {
          await _pgliteInstance!.query(ddl);
        }
        for (const idx of SCHEMA_INDEXES) {
          await _pgliteInstance!.query(idx);
        }
      })();
    }
    await _bootstrapPromise;
  }
  _db = null; // 清空 drizzle 包装，下次 getDb() 重新包装

  // Re-seed 必需数据（幂等）
  const now = new Date().toISOString();
  try {
    await _pgliteInstance!.query(
      `INSERT INTO users (id, username, email, password_hash, bio, created_at, updated_at)
       VALUES ('0', 'root', 'root@noj.local', '', '', '${now}', '${now}')
       ON CONFLICT (id) DO NOTHING`,
    );
  } catch {
    // 表可能还没建
  }
  try {
    await _pgliteInstance!.query(
      `INSERT INTO judge_images (id, image, mode, kind, description, created_at, updated_at)
       VALUES ('e0000000-0000-0000-0000-000000000001', 'noj-judge-python', 'all_versions', 'evaluator', 'Python 3.12 评测环境', '${now}', '${now}')
       ON CONFLICT (id) DO NOTHING`,
    );
    await _pgliteInstance!.query(
      `INSERT INTO judge_images (id, image, mode, kind, description, created_at, updated_at)
       VALUES ('e0000000-0000-0000-0000-000000000002', 'noj-evaluator-python', 'all_versions', 'evaluator', 'Evaluator 运行时', '${now}', '${now}')
       ON CONFLICT (id) DO NOTHING`,
    );
    await _pgliteInstance!.query(
      `INSERT INTO judge_images (id, image, mode, kind, description, created_at, updated_at)
       VALUES ('e0000000-0000-0000-0000-000000000003', 'noj-solution-python', 'all_versions', 'solution', 'Solution 运行时', '${now}', '${now}')
       ON CONFLICT (id) DO NOTHING`,
    );
  } catch {
    // 表可能还没建
  }
  // 种子 RBAC 角色和权限
  try {
    const { ensureRbacSeeds } = await import(
      "../domains/system/services/seed/seed-rbac.ts"
    );
    await ensureRbacSeeds();
  } catch {
    // 表可能还没建
  }
}

export interface ResetDbForTestOptions {
  /** 深度重置：连种子参考表（roles/permissions/role_permissions）一起清空并重建 */
  deep?: boolean;
  /** 是否在重置后刷新 user_rankings 物化视图（排名相关测试使用） */
  refreshRankings?: boolean;
}

export async function resetDbForTest(options: ResetDbForTestOptions = {}) {
  // 测试事务内：回滚已保证隔离，reset 只需清理内存缓存
  if (isInsideTestTransaction()) {
    for (const fn of _onDbResetCallbacks) fn();
    return;
  }

  // pending 状态：先执行真正的 reset 建立初始状态，再开启事务
  const shouldStartTx = _testTransactionState.status === "pending";

  const tables = RESET_TABLES;
  const truncateSql = `TRUNCATE TABLE ${tables.join(", ")} CASCADE`;
  const now = new Date().toISOString();

  if (isPGliteMode()) {
    // PGlite 模式 — 确保实例已初始化（模板加载或 DDL 引导）
    await ensurePGliteSchemaForTest();
    _db = null; // 清空 drizzle 包装，下次 getDb() 重新包装

    // TRUNCATE 保留 schema + 可选保留 RBAC 种子参考表
    try {
      await _pgliteInstance!.query(truncateSql);
    } catch {
      // 某些测试可能只建了部分表，忽略
    }
    // Re-seed 必需数据
    try {
      await _pgliteInstance!.query(
        `INSERT INTO users (id, username, email, password_hash, bio, created_at, updated_at)
         VALUES ('0', 'root', 'root@noj.local', '', '', '${now}', '${now}')
         ON CONFLICT (id) DO NOTHING`,
      );
    } catch {
      // 表可能还没建
    }
    try {
      await _pgliteInstance!.query(
        `INSERT INTO judge_images (id, image, mode, kind, description, created_at, updated_at)
         VALUES ('e0000000-0000-0000-0000-000000000001', 'noj-judge-python', 'all_versions', 'evaluator', 'Python 3.12 评测环境', '${now}', '${now}')
         ON CONFLICT (id) DO NOTHING`,
      );
      await _pgliteInstance!.query(
        `INSERT INTO judge_images (id, image, mode, kind, description, created_at, updated_at)
         VALUES ('e0000000-0000-0000-0000-000000000002', 'noj-evaluator-python', 'all_versions', 'evaluator', 'Evaluator 运行时', '${now}', '${now}')
         ON CONFLICT (id) DO NOTHING`,
      );
      await _pgliteInstance!.query(
        `INSERT INTO judge_images (id, image, mode, kind, description, created_at, updated_at)
         VALUES ('e0000000-0000-0000-0000-000000000003', 'noj-solution-python', 'all_versions', 'solution', 'Solution 运行时', '${now}', '${now}')
         ON CONFLICT (id) DO NOTHING`,
      );
    } catch {
      // 表可能还没建
    }
    // TRUNCATE 清空了 RBAC 种子表，必须重新播种
    try {
      const { ensureRbacSeeds } = await import(
        "../domains/system/services/seed/seed-rbac.ts"
      );
      await ensureRbacSeeds();
    } catch {
      // 表可能还没建
    }
    // 物化视图按需刷新（PGlite 不支持则忽略）
    if (options.refreshRankings) {
      try {
        await _pgliteInstance!.query(
          `REFRESH MATERIALIZED VIEW CONCURRENTLY user_rankings`,
        );
      } catch { /* PGlite 无物化视图支持 */ }
    }
    _db = null;
    // 通知已注册模块重置缓存（如 system_settings 内存缓存）
    for (const fn of _onDbResetCallbacks) fn();
    if (shouldStartTx) await startRealTransaction();
    return;
  }

  // postgres.js 模式：复用现有连接池，不再关闭/重建
  const db = getDb();
  try {
    await db.execute(truncateSql);
  } catch {
    // 某些表可能不存在，忽略
  }
  try {
    // re-seed root 用户（users.role 列已废弃删除）
    await db.execute(
      `INSERT INTO users (id, username, email, password_hash, bio, created_at, updated_at)
       VALUES ('0', 'root', 'root@noj.local', '', '', '${now}', '${now}')
       ON CONFLICT (id) DO NOTHING`,
    );
  } catch { /* 忽略 */ }
  // TRUNCATE 清空了 RBAC 种子表，必须重新播种
  try {
    const { ensureRbacSeeds } = await import(
      "../domains/system/services/seed/seed-rbac.ts"
    );
    await ensureRbacSeeds();
  } catch { /* 忽略 */ }
  try {
    await db.execute(
      `INSERT INTO judge_images (id, image, mode, kind, description, created_at, updated_at)
       VALUES ('e0000000-0000-0000-0000-000000000001', 'noj-judge-python', 'all_versions', 'evaluator', 'Python 3.12 评测环境', '${now}', '${now}')
       ON CONFLICT (id) DO NOTHING`,
    );
    await db.execute(
      `INSERT INTO judge_images (id, image, mode, kind, description, created_at, updated_at)
       VALUES ('e0000000-0000-0000-0000-000000000002', 'noj-evaluator-python', 'all_versions', 'evaluator', 'Evaluator 运行时', '${now}', '${now}')
       ON CONFLICT (id) DO NOTHING`,
    );
    await db.execute(
      `INSERT INTO judge_images (id, image, mode, kind, description, created_at, updated_at)
       VALUES ('e0000000-0000-0000-0000-000000000003', 'noj-solution-python', 'all_versions', 'solution', 'Solution 运行时', '${now}', '${now}')
       ON CONFLICT (id) DO NOTHING`,
    );
  } catch { /* 忽略 */ }
  // 物化视图按需刷新
  if (options.refreshRankings) {
    try {
      await db.execute(
        `REFRESH MATERIALIZED VIEW CONCURRENTLY user_rankings`,
      );
    } catch { /* 可能没有物化视图 */ }
  }
  // 通知已注册模块重置缓存（如 system_settings 内存缓存）
  for (const fn of _onDbResetCallbacks) fn();
  if (shouldStartTx) await startRealTransaction();
}

/**
 * 优雅关闭：结束 PGlite / postgres.js 连接。
 * 关闭失败只记录，不阻断进程退出。
 */
export async function closeDbForShutdown(): Promise<void> {
  try {
    if (_testTransactionState.status === "active") {
      await rollbackTestTransaction();
    }
    if (_client) {
      await _client.end();
      _client = null;
    }
    if (_pgliteInstance) {
      await _pgliteInstance.close();
      _pgliteInstance = null;
    }
    _db = null;
  } catch (err) {
    logger.error("数据库连接关闭失败", { err });
  }
}
