import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq, ne } from "drizzle-orm";
import {
  disableTestTransactionForFile,
  getDb,
  resetDbForTest,
} from "../../../../shared/db/connection.ts";
import {
  roles,
  systemSettings,
  userRoles,
  users,
} from "../../../../shared/db/schema.ts";
import {
  BadRequestError,
  ConflictError,
} from "../../../../shared/base/errors.ts";
import { ADMIN_INITIALIZATION_KEY } from "../../../../shared/security/admin-initialization.ts";
import {
  initializeFirstAdmin,
  sealExistingSiteAdminInitialization,
} from "../../services/auth/admin-initialization.ts";
import { registerUser } from "../../services/auth/auth-register.ts";
import { isUserAdmin } from "../../services/security/permissions.ts";
import { comparePassword } from "../../services/security/password.ts";

disableTestTransactionForFile();
const input = {
  username: "site_admin",
  email: "admin@example.com",
  password: "InitialAdmin-2026-Xy9",
};
function test(name: string, fn: () => Promise<void>) {
  Deno.test({
    name: `admin initialization: ${name}`,
    sanitizeResources: false,
    sanitizeOps: false,
    fn: async () => {
      await resetDbForTest();
      await fn();
    },
  });
}

test("空站创建管理员、密码仅存哈希且强制改密，不输出凭据", async () => {
  const messages: unknown[][] = [];
  const original = console.log;
  console.log = (...args) => {
    messages.push(args);
  };
  try {
    await initializeFirstAdmin(input);
  } finally {
    console.log = original;
  }
  assertEquals(JSON.stringify(messages).includes(input.password), false);
  const [user] = await getDb().select().from(users).where(
    eq(users.username, input.username),
  );
  assertEquals(await isUserAdmin(user.id), true);
  assertEquals(
    await comparePassword(input.password, user.password_hash!),
    true,
  );
  assertEquals(user.must_change_password, true);
  assertEquals(user.email_verified, false);
  await assertRejects(() => initializeFirstAdmin(input), ConflictError);
});

test("并发初始化只有一次成功", async () => {
  const results = await Promise.allSettled([
    initializeFirstAdmin(input),
    initializeFirstAdmin({
      ...input,
      username: "other_admin",
      email: "other@example.com",
    }),
  ]);
  assertEquals(results.filter((r) => r.status === "fulfilled").length, 1);
  const failed = results.find((r) =>
    r.status === "rejected"
  ) as PromiseRejectedResult;
  assertEquals(failed.reason instanceof ConflictError, true);
  assertEquals(
    (await getDb().select().from(users).where(ne(users.id, "0"))).length,
    1,
  );
});

test("公开注册与初始化竞争，公开用户绝不提权", async () => {
  const [registration, initialization] = await Promise.allSettled([
    registerUser({
      ...input,
      username: "public_user",
      email: "public@example.com",
    }),
    initializeFirstAdmin(input),
  ]);
  assertEquals(registration.status, "fulfilled");
  if (registration.status === "fulfilled") {
    assertEquals(registration.value.is_admin, false);
    assertEquals(await isUserAdmin(registration.value.id), false);
  }
  if (initialization.status === "rejected") {
    assertEquals(initialization.reason instanceof ConflictError, true);
  }
  await assertRejects(() => initializeFirstAdmin(input), ConflictError);
});

test("已有普通用户拒绝认领且不自动提权", async () => {
  const user = await registerUser({ ...input, username: "public_user" });
  await assertRejects(() => initializeFirstAdmin(input), ConflictError);
  assertEquals(await isUserAdmin(user.id), false);
});

test("升级已有用户站点永久关闭，即使随后删除用户", async () => {
  const db = getDb();
  await db.insert(users).values({
    id: "legacy",
    username: "legacy",
    email: "legacy@example.com",
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
  });
  await sealExistingSiteAdminInitialization();
  assertEquals(await isUserAdmin("legacy"), false);
  await db.delete(users).where(eq(users.id, "legacy"));
  await assertRejects(() => initializeFirstAdmin(input), ConflictError);
});

test("未经过启动检查的旧站也拒绝初始化并持久关闭", async () => {
  const db = getDb();
  await db.insert(users).values({
    id: "legacy",
    username: "legacy",
    email: "legacy@example.com",
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
  });
  await assertRejects(() => initializeFirstAdmin(input), ConflictError);
  await db.delete(users).where(eq(users.id, "legacy"));
  await assertRejects(() => initializeFirstAdmin(input), ConflictError);
});

test("完成后删除管理员仍不能重新初始化", async () => {
  const db = getDb();
  await initializeFirstAdmin(input);
  const [user] = await db.select().from(users).where(
    eq(users.username, input.username),
  );
  await db.delete(userRoles).where(eq(userRoles.user_id, user.id));
  await db.delete(users).where(eq(users.id, user.id));
  await sealExistingSiteAdminInitialization();
  await assertRejects(() => initializeFirstAdmin(input), ConflictError);
});

test("弱密码拒绝且不消耗初始化机会", async () => {
  await assertRejects(
    () => initializeFirstAdmin({ ...input, password: "weak" }),
    BadRequestError,
  );
  await initializeFirstAdmin(input);
});

test("创建失败时事务回滚关闭标记", async () => {
  const db = getDb();
  // 模拟系统尚未完成 RBAC 初始化；避免删除角色关联所带来的外键干扰。
  await db.update(roles).set({ name: "admin_unavailable" }).where(
    eq(roles.name, "admin"),
  );
  await assertRejects(() => initializeFirstAdmin(input), BadRequestError);
  assertEquals(
    (await db.select().from(systemSettings).where(
      eq(systemSettings.key, ADMIN_INITIALIZATION_KEY),
    )).length,
    0,
  );
  await db.update(roles).set({ name: "admin" }).where(
    eq(roles.name, "admin_unavailable"),
  );
  await initializeFirstAdmin(input);
});
