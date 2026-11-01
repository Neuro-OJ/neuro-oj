import { assert, assertEquals, assertMatch } from "jsr:@std/assert@^1";
import { eq, inArray } from "drizzle-orm";
import { createApp } from "../../../../../app.ts";
import { getDb } from "../../../../../shared/db/connection.ts";
import {
  auditLogs,
  passwordResetTokens,
  roles,
  userRoles,
  users,
} from "../../../../../shared/db/schema.ts";
import { resetDbForTest } from "../../../../../../tests/helpers/db.ts";
import {
  createUserToken,
  initRedisForTest,
  jsonRequest,
} from "../../../../../../tests/helper.ts";
import { comparePassword } from "../../services/security/password.ts";
import { signToken } from "../../services/security/jwt.ts";
import { validatePasswordStrength } from "../../services/auth/auth-register.ts";
import {
  _resetEnvSnapshotForTest,
  _resetSystemSettingsForTest,
  initSystemSettings,
  resetEmailProvider,
  snapshotEnv,
} from "../../../../platform/system/index.ts";
import { updateSetting } from "../../../../platform/system/services/system-settings.ts";
import { createAdminAccounts } from "../../services/admin-accounts.ts";

const base = "/api/v1/admin/identity/users";
const password = "Initial-2026-Ab1";

function accountTest(name: string, fn: () => Promise<void>) {
  Deno.test({
    name: `admin-accounts: ${name}`,
    sanitizeResources: false,
    sanitizeOps: false,
    fn: async () => {
      await resetDbForTest();
      await initRedisForTest();
      await fn();
    },
  });
}

accountTest("三个接口拒绝非管理员及未登录请求", async () => {
  const app = createApp();
  const token = await createUserToken();
  for (const path of [base, `${base}/import`, `${base}/0/reset-password`]) {
    for (const credential of [undefined, token]) {
      const response = await jsonRequest(app, path, {
        method: "POST",
        body: {},
        token: credential,
      });
      assertEquals(response.status, credential ? 403 : 401);
    }
  }
});

accountTest(
  "邮件关闭和公开注册关闭时仍可单建，默认 user、占位邮箱、强制改密及安全审计",
  async () => {
    const previous = Deno.env.get("EMAIL_PROVIDER");
    Deno.env.set("EMAIL_PROVIDER", "disabled");
    _resetEnvSnapshotForTest();
    snapshotEnv();
    _resetSystemSettingsForTest();
    await initSystemSettings();
    resetEmailProvider();
    try {
      await updateSetting("allow_register", false, "0");
      const app = createApp();
      const token = await createUserToken("admin");
      const response = await jsonRequest(app, base, {
        method: "POST",
        token,
        body: { username: "offline_student" },
      });
      assertEquals(response.status, 201);
      assertEquals(response.headers.get("Cache-Control"), "no-store");
      const { data } = await response.json();
      assertMatch(
        data.email,
        /^offline_student\.[a-f0-9]{12}@users\.noj\.invalid$/,
      );
      validatePasswordStrength(data.password, data.username, data.email);
      assertEquals("password_hash" in data, false);
      const [user] = await getDb().select().from(users).where(
        eq(users.id, data.id),
      );
      assert(user.must_change_password);
      assert(user.email_verified);
      assert(await comparePassword(data.password, user.password_hash!));
      // 临时密码使用较低 bcrypt 轮数（首次登录强制改密时按默认轮数重新哈希）
      assert(Number(user.password_hash!.split("$")[2]) <= 10);
      const assigned = await getDb().select({ name: roles.name }).from(
        userRoles,
      ).innerJoin(roles, eq(userRoles.role_id, roles.id)).where(
        eq(userRoles.user_id, data.id),
      );
      assertEquals(assigned.map((role) => role.name), ["user"]);
      const logs = await getDb().select().from(auditLogs).where(
        eq(auditLogs.target_id, data.id),
      );
      assertEquals(logs.length, 1);
      assertEquals(logs[0].action, "users.create");
      assertEquals(JSON.stringify(logs).includes(data.password), false);
      assertEquals(JSON.stringify(logs).includes("password_hash"), false);
      // 占位邮箱与不存在邮箱获得完全相同的防枚举响应，且不产生令牌。
      const forgot = await jsonRequest(app, "/api/v1/auth/forgot-password", {
        method: "POST",
        body: { email: data.email },
      });
      const missing = await jsonRequest(app, "/api/v1/auth/forgot-password", {
        method: "POST",
        body: { email: "missing@example.com" },
      });
      assertEquals(forgot.status, 200);
      assertEquals(await forgot.json(), await missing.json());
      assertEquals(
        await getDb().select().from(passwordResetTokens).where(
          eq(passwordResetTokens.user_id, data.id),
        ),
        [],
      );
    } finally {
      if (previous === undefined) Deno.env.delete("EMAIL_PROVIDER");
      else Deno.env.set("EMAIL_PROVIDER", previous);
      _resetEnvSnapshotForTest();
      snapshotEnv();
      _resetSystemSettingsForTest();
      resetEmailProvider();
    }
  },
);

accountTest(
  "单建可指定邮箱、密码和角色 ID，批量返回逐行初始凭据且审计不含密码",
  async () => {
    const app = createApp();
    const token = await createUserToken("admin");
    const [role] = await getDb().select().from(roles).where(
      eq(roles.name, "user"),
    );
    const created = await jsonRequest(app, base, {
      method: "POST",
      token,
      body: {
        username: "specified_user",
        email: "specified@example.com",
        password,
        role: role.id,
      },
    });
    assertEquals(created.status, 201);
    const single = (await created.json()).data;
    assertEquals(single.password, password);
    assertEquals(single.email, "specified@example.com");
    const response = await jsonRequest(app, `${base}/import`, {
      method: "POST",
      token,
      body: {
        role: "user",
        users: [{ username: "batch_one" }, {
          username: "batch_two",
          email: "batch_two@example.com",
          password,
        }],
      },
    });
    assertEquals(response.status, 201);
    const { data } = await response.json();
    assertEquals(data.length, 2);
    for (const item of data) {
      const [row] = await getDb().select().from(users).where(
        eq(users.id, item.id),
      );
      assert(await comparePassword(item.password, row.password_hash!));
      assert(row.must_change_password && row.email_verified);
    }
    const logs = await getDb().select().from(auditLogs).where(
      inArray(auditLogs.target_id, [single.id, data[0].id]),
    );
    assertEquals(logs.length, 2);
    assertEquals(JSON.stringify(logs).includes(password), false);
    assertEquals(JSON.stringify(logs).includes(data[0].password), false);
    assertEquals(JSON.stringify(logs).includes('"password"'), false);
    // 后续用户列表没有任何明文密码字段。
    const list = await jsonRequest(app, base, { token });
    assertEquals(
      JSON.stringify(await list.json()).includes('"password"'),
      false,
    );
  },
);

accountTest(
  "全部行先校验：格式、弱密码、批内重复与数据库冲突均整批不写入",
  async () => {
    const app = createApp();
    const token = await createUserToken("admin");
    await createAdminAccounts([{
      username: "existing_user",
      email: "exists@example.com",
    }]);
    const cases = [
      [{ username: "new_valid" }, { username: "existing_user" }],
      [{ username: "new_valid" }, {
        username: "other_user",
        email: "exists@example.com",
      }],
      [{ username: "new_valid" }, { username: "new_valid" }],
      [{ username: "new_valid", email: "same@example.com" }, {
        username: "other_user",
        email: "same@example.com",
      }],
      [{ username: "new_valid" }, {
        username: "bad-name",
        email: "bad",
        password: "weak",
      }],
      [{ username: "new_valid" }, null],
    ];
    for (const rows of cases) {
      const response = await jsonRequest(app, `${base}/import`, {
        method: "POST",
        token,
        body: { users: rows },
      });
      assertEquals(response.status, 400);
      const body = await response.json();
      assertEquals(body.code, "ACCOUNT_IMPORT_INVALID");
      assert(body.errors.some((error: { row: number }) => error.row === 2));
      assertEquals(
        await getDb().select().from(users).where(
          eq(users.username, "new_valid"),
        ),
        [],
      );
      assertEquals(
        await getDb().select().from(users).where(
          eq(users.username, "other_user"),
        ),
        [],
      );
    }
    for (
      const rows of [
        [],
        Array.from({ length: 501 }, () => ({ username: "limit_test" })),
      ]
    ) {
      assertEquals(
        (await jsonRequest(app, `${base}/import`, {
          method: "POST",
          token,
          body: { users: rows },
        })).status,
        400,
      );
    }
    const invalidRole = await jsonRequest(app, base, {
      method: "POST",
      token,
      body: { username: "invalid_role", role: "root" },
    });
    assertEquals(invalidRole.status, 400);
    assertEquals(
      await getDb().select().from(users).where(
        eq(users.username, "invalid_role"),
      ),
      [],
    );
  },
);

accountTest("并发批次争用同一用户名时，失败批次的其他账号也回滚", async () => {
  const first = [{ username: "racing_one" }, { username: "racing_shared" }];
  const second = [{ username: "racing_two" }, { username: "racing_shared" }];
  const results = await Promise.allSettled([
    createAdminAccounts(first),
    createAdminAccounts(second),
  ]);
  assertEquals(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const stored = await getDb().select().from(users).where(
    inArray(users.username, ["racing_one", "racing_two", "racing_shared"]),
  );
  assertEquals(stored.length, 2);
  const losingUsername = results[0].status === "rejected"
    ? "racing_one"
    : "racing_two";
  assertEquals(stored.some((user) => user.username === losingUsername), false);
});

accountTest(
  "管理员重置递增版本使旧 JWT 失效，支持自设/随机密码并保护 root 与已注销用户",
  async () => {
    const app = createApp();
    const token = await createUserToken("admin");
    const [user] = await createAdminAccounts([{
      username: "reset_student",
      password,
    }]);
    // 模拟用户已经完成首次改密；旧 token 可访问受保护端点。
    await getDb().update(users).set({ must_change_password: false }).where(
      eq(users.id, user.id),
    );
    const oldToken = await signToken({
      sub: user.id,
      role: "user",
      session_version: 0,
    });
    assertEquals(
      (await jsonRequest(app, "/api/v1/auth/me", { token: oldToken })).status,
      200,
    );
    const supplied = "Replacement-2026-Xy2";
    const response = await jsonRequest(
      app,
      `${base}/${user.id}/reset-password`,
      { method: "POST", token, body: { password: supplied } },
    );
    assertEquals(response.status, 200);
    assertEquals(response.headers.get("Cache-Control"), "no-store");
    assertEquals((await response.json()).data.password, supplied);
    const [row] = await getDb().select().from(users).where(
      eq(users.id, user.id),
    );
    assertEquals(row.session_version, 1);
    assert(row.must_change_password);
    assert(await comparePassword(supplied, row.password_hash!));
    assertEquals(
      (await jsonRequest(app, "/api/v1/auth/me", { token: oldToken })).status,
      401,
    );
    const randomResponse = await jsonRequest(
      app,
      `${base}/${user.id}/reset-password`,
      { method: "POST", token },
    );
    assertEquals(randomResponse.status, 200);
    const generated = (await randomResponse.json()).data.password;
    validatePasswordStrength(generated, row.username, row.email);
    assertEquals(
      (await jsonRequest(app, `${base}/0/reset-password`, {
        method: "POST",
        token,
      })).status,
      403,
    );
    await getDb().update(users).set({ deleted_at: new Date().toISOString() })
      .where(eq(users.id, user.id));
    assertEquals(
      (await jsonRequest(app, `${base}/${user.id}/reset-password`, {
        method: "POST",
        token,
      })).status,
      404,
    );
    const logs = await getDb().select().from(auditLogs).where(
      eq(auditLogs.target_id, user.id),
    );
    assertEquals(logs.length, 2);
    assertEquals(
      logs.every((log) => log.action === "users.reset_password"),
      true,
    );
    assertEquals(JSON.stringify(logs).includes(supplied), false);
    assertEquals(JSON.stringify(logs).includes(generated), false);
    assertEquals(JSON.stringify(logs).includes('"password"'), false);
  },
);
