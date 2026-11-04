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
  name: "管理员保护：LAST_ADMIN 经真实 HTTP onError 序列化为 409 + code",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    // 注入与业务入口相同的异常，验证真实 app 的全局错误序列化合同。
    app.patch("/__contract/last-admin", () => {
      throw new ConflictError("至少保留一个可用管理员", "LAST_ADMIN");
    });
    const res = await app.request("/__contract/last-admin", {
      method: "PATCH",
    });
    assertEquals(res.status, 409);
    const body = await res.json() as { code?: string; request_id?: string };
    assertEquals(body.code, "LAST_ADMIN");
    assert(typeof body.request_id === "string" && body.request_id.length > 0);
  },
});
