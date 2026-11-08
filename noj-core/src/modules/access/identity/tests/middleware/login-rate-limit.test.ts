/**
 * 账号维度登录限流 key 解析测试。
 *
 * 覆盖：
 * - resolveLoginAccountKey 按 users.id 归一化（用户名 / 邮箱指向同一账号）
 * - 不存在账号回退到 `unknown:<规范化 login>`
 * - 数据库异常时 fail-closed：抛 ServiceUnavailableError（503），
 *   Login 请求不放行且不落入会随时重置的 `unknown:` 桶
 * - checkLoginAccountRateLimit 复用已解析 key，不再重复查库
 */

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { createApp } from "../../../../../app.ts";
import {
  closeDbForShutdown,
  getDb,
} from "../../../../../shared/db/connection.ts";
import { resetDbForTest } from "../../../../../../tests/helpers/db.ts";
import { users } from "../../../../../shared/db/schema.ts";
import { eq } from "drizzle-orm";
import { ServiceUnavailableError } from "../../../../../shared/base/errors.ts";
import {
  initRedisForTest,
  jsonRequest,
} from "../../../../../../tests/helper.ts";
import { checkRateLimit } from "../../../../../shared/rate-limit/rate-limit.ts";
import { getRedis } from "../../../../../shared/mq/connection.ts";
import {
  checkLoginAccountRateLimit,
  LOGIN_LIMITS,
  resolveLoginAccountKey,
} from "../../middleware/login-rate-limit.ts";

// 登录路由经 banlistMiddleware 走 Redis，先准备共享连接。
await initRedisForTest();
await resetDbForTest();

const BASE = "/api/v1/auth";
const ts = Date.now();

/** 短暂打开限流（NOJ_ENV=test 下 RATE_LIMIT_ENABLED 可显式覆盖）。 */
async function withRateLimitEnabled<T>(fn: () => Promise<T>): Promise<T> {
  const orig = Deno.env.get("RATE_LIMIT_ENABLED");
  Deno.env.set("RATE_LIMIT_ENABLED", "true");
  try {
    return await fn();
  } finally {
    if (orig !== undefined) Deno.env.set("RATE_LIMIT_ENABLED", orig);
    else Deno.env.delete("RATE_LIMIT_ENABLED");
  }
}

async function insertUser(username: string): Promise<string> {
  const now = new Date().toISOString();
  const [row] = await getDb().insert(users).values({
    id: crypto.randomUUID(),
    username,
    email: `${username}@example.com`,
    password_hash: "x",
    created_at: now,
    updated_at: now,
  }).returning({ id: users.id });
  return row!.id;
}

async function cleanupUser(username: string) {
  try {
    await getDb().delete(users).where(eq(users.username, username));
  } catch {
    // ignore
  }
}

Deno.test({
  name: "login-rate-limit: 用户名与邮箱解析为同一 users.id",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const username = `rl_key_${ts}`;
    try {
      const id = await insertUser(username);
      assertEquals(await resolveLoginAccountKey(username), id);
      assertEquals(await resolveLoginAccountKey(`${username}@example.com`), id);
    } finally {
      await cleanupUser(username);
      await closeDbForShutdown();
    }
  },
});

Deno.test({
  name: "login-rate-limit: 不存在账号回退到 unknown:<小写 login>",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    assertEquals(
      await resolveLoginAccountKey(`NoSuchUser_${ts}`),
      `unknown:nosuchuser_${ts}`,
    );
    // 绑定参数语义：`%` / `_` 按字面比较，不会被当作通配符匹配到其他用户。
    assertEquals(await resolveLoginAccountKey(`%_${ts}`), `unknown:%_${ts}`);
    // 释放连接池，避免残留空闲连接被后续用例建立的异常 search_path 连接复用。
    await closeDbForShutdown();
  },
});

Deno.test({
  name: "login-rate-limit: checkLoginAccountRateLimit 复用已解析 key",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withRateLimitEnabled(async () => {
      // 传入 key 已计满 5 次时，复用该 key 会立即拒绝；若内部改查 "ignored-login"
      // 会落回 unknown 桶，仍是全新计数而放行。
      const key = `reused_${ts}`;
      const cfg = { windowSec: 30, max: LOGIN_LIMITS.acc.max };
      for (let i = 0; i < cfg.max; i++) {
        await checkRateLimit(`t3:acc:${key}`, cfg);
      }
      const a = await checkLoginAccountRateLimit("ignored-login", "t3", key);
      assertEquals(a.allowed, false);
      // 清理窗口计数。
      await getRedis().del(`ratelimit:t3:acc:${key}`);
    });
    await closeDbForShutdown();
  },
});

/**
 * 模拟数据库不可用：把 `DATABASE_URL` 临时指向不可达端口并重置连接池，
 * `getDb()` 会按新地址惰性重建连接，查询即失败；结束后恢复原地址与连接池。
 */
async function withUnreachableDb<T>(fn: () => Promise<T>): Promise<T> {
  const databaseUrl = Deno.env.get("DATABASE_URL");
  assert(databaseUrl, "DATABASE_URL 未设置");
  await closeDbForShutdown();
  Deno.env.set(
    "DATABASE_URL",
    "postgres://noj:noj@127.0.0.1:1/unreachable?connect_timeout=1",
  );
  try {
    return await fn();
  } finally {
    Deno.env.set("DATABASE_URL", databaseUrl!);
    await closeDbForShutdown();
  }
}

Deno.test({
  name: "login-rate-limit: DB 查询失败时 /login 返回 503（fail-closed）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withRateLimitEnabled(async () => {
      await withUnreachableDb(async () => {
        const err = await assertRejects(
          () => resolveLoginAccountKey(`dbdown_${ts}`),
          ServiceUnavailableError,
        );
        assertEquals(err.statusCode, 503);
        assert(err.cause !== undefined, "原始错误应作为 cause 保留");

        // 路由层：DB 查询失败时登录请求不得放行，也不得静默退回 unknown 桶。
        const app = createApp();
        const res = await jsonRequest(app, `${BASE}/login`, {
          method: "POST",
          body: { login: `dbdown_${ts}`, password: "WrongPwd-2024-Xy9" },
        });
        assertEquals(res.status, 503);
      });
    });
  },
});
