/**
 * legal 域删除/更正请求路由测试（用户侧）。
 *
 * 覆盖：未登录 401；提交后可查看；非法枚举 400。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { users } from "../../../../shared/db/schema.ts";
import { createApp } from "../../../../app.ts";
import { signToken } from "./../../../identity/services/security/jwt.ts";

async function makeUser(id: string) {
  const db = getDb();
  const now = new Date().toISOString();
  await db
    .insert(users)
    .values({
      id,
      username: `dru_${id}`,
      email: `${id}@example.test`,
      password_hash: "",
      created_at: now,
      updated_at: now,
    })
    .onConflictDoNothing();
  return await signToken({ sub: id, role: "user" });
}

Deno.test({
  name: "data-requests routes: 未登录 401",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await resetDbForTest();
    const app = createApp();
    const res = await app.request("/api/v1/legal/data-requests");
    assertEquals(res.status, 401);
  },
});

Deno.test({
  name: "data-requests routes: 提交后可查看自己的请求",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await resetDbForTest();
    const token = await makeUser("dru-1");
    const app = createApp();

    const create = await app.request("/api/v1/legal/data-requests", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        kind: "delete",
        target_type: "post",
        target_id: "post-9",
        detail: "请删除",
      }),
    });
    assertEquals(create.status, 201);

    const list = await app.request("/api/v1/legal/data-requests", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assertEquals(list.status, 200);
    const body = await list.json();
    assertEquals(body.data.length, 1);
    assertEquals(body.data[0].kind, "delete");
  },
});

Deno.test({
  name: "data-requests routes: 非法 target_type 返回 400",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await resetDbForTest();
    const token = await makeUser("dru-2");
    const app = createApp();
    const res = await app.request("/api/v1/legal/data-requests", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        kind: "delete",
        target_type: "bogus",
        detail: "x",
      }),
    });
    assertEquals(res.status, 400);
  },
});

Deno.test({
  name: "data-requests routes: 用户 B 看不到用户 A 的请求（越权隔离）",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await resetDbForTest();
    const tokenA = await makeUser("dru-a");
    const tokenB = await makeUser("dru-b");
    const app = createApp();

    const created = await app.request("/api/v1/legal/data-requests", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        kind: "delete",
        target_type: "post",
        detail: "A 的请求",
      }),
    });
    assertEquals(created.status, 201);
    const idA = ((await created.json()) as { data: { id: string } }).data.id;

    // A 能看到自己的
    const listA = await app.request("/api/v1/legal/data-requests", {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const rowsA =
      ((await listA.json()) as { data: Array<{ id: string }> }).data;
    assertEquals(rowsA.some((r) => r.id === idA), true);

    // B 看不到 A 的
    const listB = await app.request("/api/v1/legal/data-requests", {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    const rowsB =
      ((await listB.json()) as { data: Array<{ id: string }> }).data;
    assertEquals(rowsB.some((r) => r.id === idA), false);
    assertEquals(rowsB.length, 0);
  },
});
