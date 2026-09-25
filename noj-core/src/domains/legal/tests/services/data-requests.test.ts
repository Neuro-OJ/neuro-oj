/**
 * 删除/更正请求服务测试。
 *
 * 覆盖：创建、本人列表、状态机合法/非法转换、未知请求报错。
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { users } from "../../../../shared/db/schema.ts";
import {
  BadRequestError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import {
  createDataRequest,
  listUserDataRequests,
  updateDataRequestStatus,
} from "../../index.ts";

const USER = "dr-test-user";

async function setup() {
  await resetDbForTest();
  const db = getDb();
  const now = new Date().toISOString();
  await db
    .insert(users)
    .values({
      id: USER,
      username: "dr-user",
      email: "dr-user@example.test",
      password_hash: "",
      created_at: now,
      updated_at: now,
    })
    .onConflictDoNothing();
}

Deno.test({
  name: "data-requests: 创建后本人可见且状态 pending",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await setup();
    const id = await createDataRequest(
      USER,
      "delete",
      "post",
      "post-1",
      "请删除我的帖子",
    );
    const rows = await listUserDataRequests(USER);
    assertEquals(rows.length, 1);
    assertEquals(rows[0].id, id);
    assertEquals(rows[0].status, "pending");
  },
});

Deno.test({
  name: "data-requests: 非法枚举拒绝",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await setup();
    await assertRejects(
      () => createDataRequest(USER, "bogus", "post", null, "x"),
      Error,
    );
  },
});

Deno.test({
  name: "data-requests: 状态机转换（合法通过、非法与未知请求拒绝）",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await setup();
    const id = await createDataRequest(
      USER,
      "correct",
      "profile",
      null,
      "更正",
    );

    await updateDataRequestStatus(id, "processing", USER, null);
    await updateDataRequestStatus(id, "resolved", USER, "已处理");

    // resolved 为终态：不能再回到 pending
    await assertRejects(
      () => updateDataRequestStatus(id, "pending", USER, null),
      BadRequestError,
    );
    // 未知请求
    await assertRejects(
      () => updateDataRequestStatus("nope", "processing", USER, null),
      NotFoundError,
    );
  },
});
