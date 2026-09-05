/**
 * authMiddleware must_change_password 拦截测试（issue #75）。
 *
 * 覆盖：
 * - 非白名单路径 → 403 PASSWORD_CHANGE_REQUIRED
 * - 白名单路径（/api/v1/auth/change-password, /api/v1/auth/me）→ 放行
 * - 正常 token（无 must_change_password flag）→ 通行
 * - mustChangePassword context 变量正确注入
 */

import { assertEquals } from "jsr:@std/assert@^1";
import { initRedisForTest } from "../../../../../tests/helper.ts";
import { Hono } from "hono";
import {
  authMiddleware,
  PASSWORD_CHANGE_WHITELIST,
} from "../../middleware/auth.ts";
import { AppError } from "../../../../shared/base/errors.ts";
import { signToken } from "../../services/security/jwt.ts";
import { jsonRequest } from "../../../../../tests/helper.ts";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { users } from "../../../../shared/db/schema.ts";

const hasEnv = !!Deno.env.get("JWT_SECRET");

// 初始化 PGlite schema（含 user_bans 表），供 authMiddleware 封禁检查使用
await resetDbForTest();
await initRedisForTest();

async function createToken(mustChangePassword?: boolean) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await getDb().insert(users).values({
    id,
    username: `must_change_${id.slice(0, 8)}`,
    email: `must_change_${id.slice(0, 8)}@example.com`,
    password_hash: "test-only",
    created_at: now,
    updated_at: now,
  });
  return {
    id,
    token: await signToken({
      sub: id,
      role: "user",
      ...(mustChangePassword === undefined
        ? {}
        : { must_change_password: mustChangePassword }),
    }),
  };
}

// deno-lint-ignore no-explicit-any
function registerAppErrorHandler(app: Hono<any, any, "/">) {
  app.onError((err, c) => {
    if (err instanceof AppError) {
      const requestId = crypto.randomUUID();
      return c.json(
        {
          error: err.message,
          code: err.code,
          request_id: requestId,
        },
        err.statusCode as 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503,
      );
    }
    console.error("未处理的错误:", err);
    return c.json({ error: "服务器内部错误" }, 500);
  });
}

function createTestApp() {
  const app = new Hono<{
    Variables: {
      userId: string;
      userRole: string;
      mustChangePassword: boolean;
    };
  }>();

  // deno-lint-ignore no-explicit-any
  registerAppErrorHandler(app as Hono<any, any, "/">);

  // 受保护的非白名单路径
  app.get("/protected", authMiddleware, (c) => {
    return c.json({
      userId: c.get("userId"),
      userRole: c.get("userRole"),
      mustChangePassword: c.get("mustChangePassword"),
    });
  });

  // 白名单路径：change-password
  app.post("/api/v1/auth/change-password", authMiddleware, (c) => {
    return c.json({ ok: true });
  });

  // 白名单路径：me
  app.get("/api/v1/auth/me", authMiddleware, (c) => {
    return c.json({
      userId: c.get("userId"),
      mustChangePassword: c.get("mustChangePassword"),
    });
  });

  return app;
}

Deno.test({
  name: "must_change: 非白名单路径返回 403 PASSWORD_CHANGE_REQUIRED",
  ignore: !hasEnv,
  fn: async () => {
    const app = createTestApp();
    const { token } = await createToken(true);

    const res = await jsonRequest(app, "/protected", { token });
    assertEquals(res.status, 403);

    const body = await res.json();
    assertEquals(body.code, "PASSWORD_CHANGE_REQUIRED");
    assertEquals(body.error, "请先修改密码");
  },
});

Deno.test({
  name: "must_change: 白名单路径 /api/v1/auth/change-password 放行",
  ignore: !hasEnv,
  fn: async () => {
    const app = createTestApp();
    const { token } = await createToken(true);

    const res = await jsonRequest(app, "/api/v1/auth/change-password", {
      method: "POST",
      token,
    });
    assertEquals(res.status, 200);
  },
});

Deno.test({
  name: "must_change: 白名单路径 /api/v1/auth/me 放行",
  ignore: !hasEnv,
  fn: async () => {
    const app = createTestApp();
    const { token } = await createToken(true);

    const res = await jsonRequest(app, "/api/v1/auth/me", { token });
    assertEquals(res.status, 200);

    const body = await res.json();
    assertEquals(body.mustChangePassword, true);
  },
});

Deno.test({
  name: "must_change: 正常 token（无 flag）放行非白名单路径",
  ignore: !hasEnv,
  fn: async () => {
    const app = createTestApp();
    const { id, token } = await createToken();

    const res = await jsonRequest(app, "/protected", { token });
    assertEquals(res.status, 200);

    const body = await res.json();
    assertEquals(body.userId, id);
    assertEquals(body.mustChangePassword, false);
  },
});

Deno.test({
  name: "must_change: must_change_password=false 的 token 放行非白名单路径",
  ignore: !hasEnv,
  fn: async () => {
    const app = createTestApp();
    const { token } = await createToken(false);

    const res = await jsonRequest(app, "/protected", { token });
    assertEquals(res.status, 200);
  },
});

Deno.test({
  name: "must_change: 缺少 Authorization 头仍返回 401（非 403）",
  ignore: !hasEnv,
  fn: async () => {
    const app = createTestApp();

    const res = await jsonRequest(app, "/protected");
    assertEquals(res.status, 401);

    const body = await res.json();
    assertEquals(body.error, "未提供认证令牌");
  },
});

Deno.test({
  name:
    "must_change: PASSWORD_CHANGE_WHITELIST 包含 /api/v1/auth/change-password、/me、/logout",
  ignore: !hasEnv,
  fn: () => {
    assertEquals(
      PASSWORD_CHANGE_WHITELIST.includes("/api/v1/auth/change-password"),
      true,
    );
    assertEquals(PASSWORD_CHANGE_WHITELIST.includes("/api/v1/auth/me"), true);
    assertEquals(
      PASSWORD_CHANGE_WHITELIST.includes("/api/v1/auth/logout"),
      true,
    );
  },
});
