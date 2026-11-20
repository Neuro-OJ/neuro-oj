/** 登录锁定、管理员解锁与认证命名空间的路由回归。 */
import { assertEquals } from "jsr:@std/assert@^1";
import { and, eq } from "drizzle-orm";
import { TOTP } from "otpauth";
import { createApp } from "../../../../../app.ts";
import { getDb } from "../../../../../shared/db/connection.ts";
import { auditLogs } from "../../../../../shared/db/schema.ts";
import { getRedis } from "../../../../../shared/mq/connection.ts";
import { resetDbForTest } from "../../../../../../tests/helpers/db.ts";
import {
  createUserToken,
  initRedisForTest,
  jsonRequest,
} from "../../../../../../tests/helper.ts";
import { registerUser } from "../../services/auth.ts";
import { signToken } from "../../services/security/jwt.ts";
import {
  _resetLoginBackoffForTest,
  applyLoginBackoff,
  clearAllLoginFailures,
  isLoginLocked,
  recordLoginBackoff,
  recordLoginFailure,
} from "../../services/security/loginThrottle.ts";

await resetDbForTest();
await initRedisForTest();
const ipA = "192.0.2.81";
const ipB = "2001:db8::82";
const password = "CorrectPwd-2024-Ab1";

/** 只覆盖本用例的限流与 TFA 配置，保留测试数据库环境。 */
async function withSecuritySettings(action: () => Promise<void>) {
  const names = ["RATE_LIMIT_ENABLED", "TFA_ENCRYPTION_KEY"];
  const previous = names.map((name) => Deno.env.get(name));
  Deno.env.set("RATE_LIMIT_ENABLED", "true");
  Deno.env.set(
    "TFA_ENCRYPTION_KEY",
    "test-tfa-encryption-key-with-32-chars-min",
  );
  try {
    await action();
  } finally {
    _resetLoginBackoffForTest();
    names.forEach((name, index) => {
      const value = previous[index];
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    });
  }
}

async function fixture() {
  const username = `unlock-${crypto.randomUUID().slice(0, 12)}`;
  const user = await registerUser({
    username,
    email: `${username}@example.com`,
    password,
  });
  const token = await signToken({ sub: user.id, role: "user" });
  return { user, token };
}

for (const role of [undefined, "user"] as const) {
  Deno.test({
    name: `admin unlock-login: ${role ? "普通用户返回 403" : "未登录返回 401"}`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      const token = role ? await createUserToken(role) : undefined;
      const res = await jsonRequest(
        createApp(),
        "/api/v1/admin/identity/users/target/unlock-login",
        {
          method: "POST",
          token,
        },
      );
      assertEquals(res.status, role ? 403 : 401);
    },
  });
}

Deno.test({
  name:
    "admin unlock-login: 清除所有 IP、命名空间与本进程退避，审计唯一且保留窗口",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () =>
    await withSecuritySettings(async () => {
      const { user } = await fixture();
      const adminToken = await createUserToken("admin");
      const app = createApp();
      const redis = getRedis();
      const windowKeys = [
        `ratelimit:login:acc:${user.id}`,
        `ratelimit:login:ip:${ipA}`,
      ];
      const identifiers = [user.id, user.username, `unknown:${user.id}`];
      try {
        for (const identifier of identifiers) {
          for (const ns of ["login", "pwchange", "tfa", "custom-ns"]) {
            for (const ip of [ipA, ipB]) {
              for (let i = 0; i < 10; i++) {
                await recordLoginFailure(identifier, ip, ns);
              }
              recordLoginBackoff(identifier, ip, 1, ns);
            }
          }
        }
        for (const key of windowKeys) {
          await redis.set(key, "2", "EX", 30);
        }
        const result = await jsonRequest(
          app,
          `/api/v1/admin/identity/users/${user.id}/unlock-login`,
          {
            method: "POST",
            token: adminToken,
          },
        );
        assertEquals(result.status, 200);
        assertEquals((await result.json()).data.id, user.id);
        for (const identifier of identifiers) {
          for (const ns of ["login", "pwchange", "tfa", "custom-ns"]) {
            for (const ip of [ipA, ipB]) {
              assertEquals(await isLoginLocked(identifier, ip, ns), false);
              await applyLoginBackoff(identifier, ip, ns);
              assertEquals(await recordLoginFailure(identifier, ip, ns), 1);
            }
          }
        }
        for (const key of windowKeys) assertEquals(await redis.get(key), "2");
        for (const ip of [ipA, ipB]) {
          const login = await jsonRequest(app, "/api/v1/auth/login", {
            method: "POST",
            ip,
            body: { login: user.username, password },
          });
          assertEquals(login.status, 200);
        }
        const logs = await getDb().select().from(auditLogs).where(and(
          eq(auditLogs.action, "users.unlock_login"),
          eq(auditLogs.target_id, user.id),
        ));
        assertEquals(logs.length, 1);
        assertEquals(logs[0].target_type, "user");
        assertEquals(
          (logs[0].detail as { action?: string } | null)?.action,
          "users.unlock_login",
        );
      } finally {
        for (const identifier of identifiers) {
          await clearAllLoginFailures(identifier);
        }
        await redis.del(...windowKeys);
        // 测试库按运行隔离且用户 ID 随机；不删除用户，避免与审计、成员等外键耦合。
      }
    }),
});

Deno.test({
  name: "admin unlock-login: 不存在的用户返回 404",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const token = await createUserToken("admin");
    const result = await jsonRequest(
      createApp(),
      `/api/v1/admin/identity/users/${crypto.randomUUID()}/unlock-login`,
      {
        method: "POST",
        token,
      },
    );
    assertEquals(result.status, 404);
  },
});

for (const ns of ["pwchange", "tfa"]) {
  Deno.test({
    name: `auth ${ns}: 失败锁定当前 IP，其他 IP 成功仅清理自身且不污染 login`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () =>
      await withSecuritySettings(async () => {
        const { user, token } = await fixture();
        const app = createApp();
        const path = ns === "pwchange"
          ? "/api/v1/auth/change-password"
          : "/api/v1/auth/tfa/confirm";
        let correctCode = "";
        if (ns === "tfa") {
          const setup = await jsonRequest(app, "/api/v1/auth/tfa/setup", {
            method: "POST",
            token,
          });
          assertEquals(setup.status, 200);
          correctCode = new TOTP({
            secret: (await setup.json()).data.secret,
            issuer: "NeuroOJ",
          }).generate();
        }
        const validBody = ns === "pwchange"
          ? { old_password: password, new_password: "UpdatedPwd-2024-Cd2" }
          : { code: correctCode };
        const invalidBody = ns === "pwchange"
          ? {
            old_password: "WrongPwd-2024-Xy9",
            new_password: "UpdatedPwd-2024-Cd2",
          }
          : {
            code: String((Number(correctCode) + 1) % 1_000_000).padStart(
              6,
              "0",
            ),
          };
        try {
          await recordLoginFailure(user.id, ipA, "login");
          for (let i = 0; i < 9; i++) {
            await recordLoginFailure(user.id, ipA, ns);
          }
          await recordLoginFailure(user.id, ipB, ns);
          const failed = await jsonRequest(app, path, {
            method: "POST",
            token,
            ip: ipA,
            body: invalidBody,
          });
          assertEquals(failed.status, 401);
          assertEquals(await isLoginLocked(user.id, ipA, ns), true);
          _resetLoginBackoffForTest();
          const locked = await jsonRequest(app, path, {
            method: "POST",
            token,
            ip: ipA,
            body: validBody,
          });
          assertEquals(locked.status, 401);
          assertEquals(
            (await locked.json()).error,
            "登录尝试过多，账号已临时锁定",
          );
          const success = await jsonRequest(app, path, {
            method: "POST",
            token,
            ip: ipB,
            body: validBody,
          });
          assertEquals(success.status, 200);
          assertEquals(
            await getRedis().exists(`${ns}fail:${user.id}:${ipB}`),
            0,
          );
          assertEquals(await isLoginLocked(user.id, ipA, ns), true);
          assertEquals(
            await getRedis().get(`loginfail:${user.id}:${ipA}`),
            "1",
          );
          assertEquals(await isLoginLocked(user.id, ipA, "login"), false);
        } finally {
          await clearAllLoginFailures(user.id);
          // 测试库按运行隔离且用户 ID 随机；不删除用户，避免与审计、成员等外键耦合。
        }
      }),
  });
}
