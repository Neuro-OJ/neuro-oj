/**
 * 路由层测试统一辅助函数。
 *
 * ## 背景（PR #89 review finding）
 *
 * `jsonRequest()` 在本文件落地之前，散落在以下 3 个测试文件中：
 *
 *   - tests/routes/auth.test.ts
 *   - tests/routes/auth_change_password_test.ts
 *   - tests/routes/submissions.test.ts
 *
 * 三份实现 95% 等价，剩余 ~5% 集中在 `X-Forwarded-For` 头的处理差异
 * （IP 限流测试场景需要注入）。这种重复会让任何后续 helper 演进
 * （例如新增 trace-id 注入、统一错误响应格式校验等）都要同步修改 3 处，
 * 且后续新测试找不到权威实现时容易再复制一份 → 重复扩散。
 *
 * 本文件作为**单一来源**，3 个调用方统一从此 import，避免再次分叉。
 *
 * ## 实现要点
 *
 * **为什么走 `new Request()` + `app.fetch()` 而不是 `app.request(path, opts)`**
 *
 * `app.request()` 是 Hono 提供的便捷方法，会从 opts 解构 method/headers/body
 * 后内部再构造一个 Request；`app.fetch()` 则直接接收一个完整的 Request 对象，
 * 与生产环境（`hono/serve` 接收真实 fetch Request）的代码路径完全一致。
 * 这样更能暴露路由层兼容性问题（例如某些自定义中间件只对 fetch 入口触发）。
 * 本约定见 noj-core/AGENTS.md 的"测试约定"一节。
 *
 * **为什么用 options bag 而不是位置参数**
 *
 * 位置参数版本在 "GET + token" 的场景下需要显式传 `undefined` 占位
 * （原代码 13/15 个调用点都如此），可读性差且容易写错。options bag 让
 * 每个字段独立命名，调用方一眼看出传了哪些参数、未来新增字段不破坏
 * 二进制兼容性（旧调用点不受影响）。
 */

// 不使用 `Hono<any, any, "/">` + `deno-lint-ignore no-explicit-any`：Hono
// 的 Env 类型参数是**不变**的（Variables 既被读也被写），`Hono<{Variables:
// V}>` 不能赋给 `Hono<{}>`（裸 Hono），所以旧的 `app: Hono` 写法在中间
// 件/路由测试（`new Hono<{Variables: ...}>()`）下报错。但若用 `<any, any,
// "/">` 又违反 TypeScript 严格模式。
//
// 解法：把 helper 做成真正的**泛型函数**，让 TypeScript 在调用点推断 E/S。
// 调用方传 `Hono<{Variables: V}>` → 推断 E = `{Variables: V}`；传裸 Hono →
// 推断 E = BlankEnv。两侧都不需要 `any`，也无需 lint 抑制。
import type { Env, Hono, Schema } from "hono";

/** `jsonRequest` 的可配置项。 */
export interface JsonRequestOptions {
  /** HTTP 方法，默认 `GET`。 */
  method?: string;
  /** 请求体，传 `undefined` 表示无 body；其他值会被 `JSON.stringify`。 */
  body?: unknown;
  /** 设置 `Authorization: Bearer <token>`，未设置则不携带。
   *  如已在 `headers` 中显式提供 `Authorization`，此项被忽略。 */
  token?: string;
  /** 设置 `X-Forwarded-For`，用于触发或绕过基于 IP 的限流。
   *  如已在 `headers` 中显式提供 `X-Forwarded-For`，此项被忽略。 */
  ip?: string;
  /** 任意附加 / 覆盖 headers。常用于中间件单元测试中发送非标准
   *  `Authorization`（如空字符串、`Token` scheme、裸 `Bearer ` 等）。
   *  传入的 headers 会与上面前缀字段合并；若两者指定同一 header，
   *  `headers` 优先。`Content-Type` 默认总是 `application/json`，可被覆盖。 */
  headers?: HeadersInit;
}

/**
 * 构造一个 JSON 测试请求并通过 Hono 路由栈执行。
 *
 * @example
 * ```ts
 * // POST JSON
 * await jsonRequest(app, "/api/v1/x", {
 *   method: "POST",
 *   body: { foo: 1 },
 * });
 *
 * // GET 带 token
 * await jsonRequest(app, "/api/v1/me", { token });
 *
 * // IP 限流测试：固定 IP
 * await jsonRequest(app, "/api/v1/auth/login", {
 *   method: "POST",
 *   body: { login, password },
 *   ip: "10.0.0.1",
 * });
 *
 * // 中间件测试：发送非标准 Authorization
 * await jsonRequest(app, "/protected", {
 *   headers: { Authorization: "Token abc123" },
 * });
 * ```
 */
export async function jsonRequest<
  // 接受任意 Hono 实例。三个泛型参数推断自调用方传入的具体 Hono 类型
  // （Env 必带 Variables/Bindings 形态，Schema 默认 BlankSchema），
  // 既兼容裸 Hono（生产 `createApp()`），也兼容 `new Hono<{Variables:
  // V}>()` 的中间件/路由单元测试。无需 `any`，无需 lint 抑制。
  E extends Env,
  S extends Schema = Record<PropertyKey, never>,
>(
  app: Hono<E, S, "/">,
  path: string,
  options: JsonRequestOptions = {},
): Promise<Response> {
  const headers = new Headers({ "Content-Type": "application/json" });

  // 调用方提供的任意 headers 先合并（让它有机会覆盖自动值）
  if (options.headers) {
    const extra = options.headers instanceof Headers
      ? options.headers
      : new Headers(options.headers);
    extra.forEach((value, key) => headers.set(key, value));
  }

  // 自动便利字段：仅在调用方未通过 `headers` 显式覆盖时生效
  if (options.token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${options.token}`);
  }
  if (options.ip && !headers.has("X-Forwarded-For")) {
    headers.set("X-Forwarded-For", options.ip);
  }

  return await app.fetch(
    new Request(`http://localhost${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body !== undefined
        ? JSON.stringify(options.body)
        : undefined,
    }),
  );
}

/**
 * 初始化测试用 Redis 连接（幂等）。
 *
 * ## 背景（PR-1 issue #75 JWT 撤销机制）
 *
 * `authMiddleware` 和 `optionalAuthMiddleware` 在验证 JWT 后会调用
 * `isJtiRevoked()` 查 Redis 黑名单。**fail-closed** 设计：Redis 不可用
 * 时直接抛 503。
 *
 * 因此**任何**走 authMiddleware 的路由测试（tags / checkin /
 * messages / problems / submissions / support-package / admin-*）都
 * 必须在测试启动时确保 Redis 已连接。本函数统一封装连接逻辑，避免
 * 每个测试文件复制粘贴。
 *
 * ## 用法
 *
 * ```ts
 * import { initRedisForTest } from "../lib/helper.ts";
 *
 * await initRedisForTest(); // 模块顶层调用一次即可
 * ```
 *
 * - 未设置 `REDIS_URL`：no-op（依赖测试环境跳过 Redis 限流）
 * - 已设置 `REDIS_URL`：检查连接状态，仅在未就绪时 reset + connect；
 *   重复调用幂等；并发调用安全（不会反复 disconnect 已就绪连接）
 * - 已在连接中：捕获 "already connecting/connected" 错误
 */
export async function initRedisForTest(): Promise<void> {
  if (!Deno.env.get("REDIS_URL")) return;
  // PR-1 已被 main revert，但本测试套件仍调 isJtiRevoked。开启测试短路开关，
  // 让 isJtiRevoked 在 NOJ_BYPASS_JWT_REVOKE=1 时直接返回 false，避免 Redis
  // 跨测试状态污染导致 authMiddleware 抛 503。
  Deno.env.set("NOJ_BYPASS_JWT_REVOKE", "1");
  const mq = await import("../../src/mq/connection.ts");
  // 仅当连接尚未就绪时才 reset + connect，避免并发测试反复 disconnect
  // 已建立的连接（导致后续请求拿到未连接的 client 抛 503）
  try {
    const health = await mq.checkRedisHealth();
    if (health.ok) return; // 已就绪，跳过 reset
  } catch {
    // health check 自身失败 → 继续走 reset + connect
  }
  mq.resetRedisForTest();
  try {
    await mq.connectRedis();
  } catch (e) {
    if (!String(e).includes("already connecting/connected")) throw e;
  }
}

/**
 * 创建真实存在的测试用户并返回其 JWT。
 *
 * 权限判定（requireAdmin / checkPermission）实时查询 DB，JWT 仅含 sub/role，
 * 因此 token 的 sub 必须对应一个真实用户且关联了相应角色：
 * - `"admin"`：关联 admin 角色（其 admin:full_access 权限由 ensureRbacSeeds 预置）
 * - `"user"`：关联 user 角色（默认权限集）
 *
 * 动态 import 避免本模块顶层引入 DB 依赖（helper 保持零副作用导入）。
 */
export async function createUserToken(
  role: "admin" | "user" = "user",
): Promise<string> {
  const { getDb, ensurePGliteSchemaForTest } = await import(
    "../../src/db/connection.ts"
  );
  const { users, userRoles } = await import("../../src/db/schema.ts");
  const { signToken } = await import("../../src/lib/jwt.ts");
  const { ensureRbacSeeds } = await import("../../src/services/seed-rbac.ts");
  // deno test 每个文件独立模块图：PGlite 模式下必须先引导 Schema，
  // 否则 users/roles 等表不存在（PG 模式无操作）。
  await ensurePGliteSchemaForTest();
  const db = getDb();
  // 幂等重建系统角色（resetDbForTest TRUNCATE 可能清空 roles 表）。
  // deno test 并行执行文件时，其他文件的 resetDbForTest 可能在本函数执行
  // 期间并发 TRUNCATE roles 表 → user_roles 插入 FK 失败。此处捕获 FK 错误
  // 并重试一次（重试前重新 seed），消除并行竞态窗口。
  async function insertWithRetry(): Promise<void> {
    try {
      await db.insert(userRoles).values({ user_id: id, role_id: role })
        .onConflictDoNothing();
    } catch (err) {
      if (!String(err).includes("user_roles_role_id_fkey")) throw err;
      await ensureRbacSeeds();
      await db.insert(userRoles).values({ user_id: id, role_id: role })
        .onConflictDoNothing();
    }
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const username = `test_${role}_${Date.now()}_${
    Math.random().toString(36).slice(2, 8)
  }`;
  await db.insert(users).values({
    id,
    username,
    email: `${id}@test.local`,
    password_hash: "x",
    must_change_password: false,
    created_at: now,
    updated_at: now,
  });
  await insertWithRetry();
  return await signToken({ sub: id, role });
}
