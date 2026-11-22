/**
 * LAST_ADMIN 契约：状态码、错误码与 HTTP 序列化。
 *
 * “至少保留一个可用管理员”由 `assertAvailableAdminRemainsTx` 在事务内判定；
 * 客户端合同是 **409 + code=LAST_ADMIN**。此前只有并发用例断言错误文案，
 * 状态码或错误码被改动时不会有红灯，因此这里把两层合同都钉住：
 * 1. 锁内计数口径：最后一个可用管理员被排除后必须抛 409 LAST_ADMIN；
 * 2. HTTP 序列化：真实 `createApp()` 的全局 onError 必须输出 409 与同一 code。
 */
import { assert, assertEquals } from "jsr:@std/assert@^1";
import { and, eq, ne } from "drizzle-orm";
import { createApp } from "../../../app.ts";
import { hashPassword } from "../identity/services/security/password.ts";
import { signToken } from "../identity/index.ts";
import { jsonRequest } from "../../../../tests/helper.ts";
import { getDb } from "../../../shared/db/connection.ts";
import { ROOT_USER_ID } from "../../../shared/base/constants.ts";
import { ConflictError } from "../../../shared/base/errors.ts";
import { users } from "../../../shared/db/schema.ts";
import { resetDbForTest } from "../../../../tests/helpers/db.ts";
import {
  assertAvailableAdminRemainsTx,
  lockAdminMutationsTx,
} from "../admin-policy.ts";

async function account(role: "admin" | "user" = "admin"): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await getDb().insert(users).values({
    id,
    username: id,
    email: `${id}@example.com`,
    role,
    created_at: now,
    updated_at: now,
  });
  return id;
}

Deno.test({
  name: "管理员保护：排除最后一个可用管理员后抛 409 LAST_ADMIN",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const target = await account();
    let caught: unknown;
    try {
      await getDb().transaction(async (tx) => {
        await lockAdminMutationsTx(tx);
        // 仅在本事务内把其他管理员降级，构造“目标就是最后一个可用管理员”。
        // 抛出即回滚，不会污染其他用例的管理员集合。
        await tx.update(users).set({ role: "user" }).where(
          and(
            eq(users.role, "admin"),
            ne(users.id, target),
            ne(users.id, ROOT_USER_ID),
          ),
        );
        await assertAvailableAdminRemainsTx(tx, target);
      });
    } catch (error) {
      caught = error;
    }
    assert(caught instanceof ConflictError);
    assertEquals(caught.status, 409);
    assertEquals(caught.code, "LAST_ADMIN");
    assertEquals(caught.message, "至少保留一个可用管理员");
  },
});

Deno.test({
  name: "管理员保护：唯一可用管理员自助注销走真实端点返回 409 LAST_ADMIN",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const password = "AdminPass1234";
    await getDb().insert(users).values({
      id,
      username: `solo_${id.slice(0, 8)}`,
      email: `${id}@example.com`,
      password_hash: await hashPassword(password),
      role: "admin",
      must_change_password: false,
      email_verified: true,
      created_at: now,
      updated_at: now,
    });
    const token = await signToken({ sub: id, role: "admin" });
    const app = createApp();
    // 真实业务端点：自助注销会排除本人后统计可用管理员，唯一管理员必须被拒绝。
    // 这里同时锁定 409 状态码、错误码与全局 onError 的 request_id 合同。
    const res = await jsonRequest(app, "/api/v1/users/me/delete-account", {
      method: "POST",
      token,
      body: { password },
    });
    assertEquals(res.status, 409);
    const body = await res.json() as { code?: string; request_id?: string };
    assertEquals(body.code, "LAST_ADMIN");
    assert(typeof body.request_id === "string" && body.request_id.length > 0);
    const [still] = await getDb().select({ deleted_at: users.deleted_at })
      .from(users).where(eq(users.id, id));
    assertEquals(still!.deleted_at, null);
  },
});
