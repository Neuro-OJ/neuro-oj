/**
 * 私信路由层单元测试。
 *
 * 使用 Hono app.request() 直接测试路由层逻辑（不依赖外部 HTTP 服务器）。
 * 需要 PostgreSQL 已在环境中运行。
 *
 * 覆盖所有私信端点：Conversations CRUD、Messages、Read、Delete、
 * Unread Count 以及认证校验。
 */

import { assertEquals, assertExists } from "jsr:@std/assert@^1";
import { eq, or } from "drizzle-orm";
import { createApp } from "../../src/app.ts";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import { conversations, users } from "../../src/db/schema.ts";
import { hashPassword } from "../../src/lib/password.ts";
import { signToken } from "../../src/lib/jwt.ts";

// 模块级 bootstrap：确保 PGlite schema 已创建
await resetDbForTest();

const hasDb = true; // PGlite 内存数据库始终可用
const hasJwt = !!Deno.env.get("JWT_SECRET");
const skip = !(hasDb && hasJwt);

const BASE = "/api/v1/conversations";

// ─── 测试辅助函数 ────────────────────────────────────────────────

async function createTestUser(): Promise<string> {
  const db = getDb();
  const id = crypto.randomUUID();
  const unique = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  await db.insert(users).values({
    id,
    username: `rt_msg_${unique}`,
    email: `rt_msg_${unique}@test.com`,
    password_hash: await hashPassword("TestMsgPass1"),
    role: "user",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  return id;
}

async function getToken(userId: string, role = "user"): Promise<string> {
  return await signToken({ sub: userId, role });
}

async function cleanup(...userIds: string[]): Promise<void> {
  const db = getDb();
  for (const uid of userIds) {
    await db.delete(conversations).where(
      or(eq(conversations.user1_id, uid), eq(conversations.user2_id, uid)),
    );
    await db.delete(users).where(eq(users.id, uid));
  }
}


// ─── 认证校验 ────────────────────────────────────────────────────

Deno.test({
  name: "messages route: 无 token 返回 401",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const res = await app.request(BASE + "/999");
    assertEquals(res.status, 401);
  },
});

Deno.test({
  name: "messages route: 无效 token 返回 401",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const res = await app.request(BASE + "/999", {
      headers: { Authorization: "Bearer invalid_token_here" },
    });
    assertEquals(res.status, 401);
  },
});

Deno.test({
  name: "messages route: 匿名路由 /:id/messages 仍要求认证",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const res = await app.request(BASE + "/some-id/messages");
    assertEquals(res.status, 401);
  },
});

// ─── Conversation 端点 ──────────────────────────────────────────

Deno.test({
  name: "messages route: POST /conversations 创建新会话返回 201",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    try {
      const app = createApp();
      const token = await getToken(userA);
      const res = await app.request(BASE, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ other_user_id: userB }),
      });
      assertEquals(res.status, 201);
      const body = await res.json();
      assertExists(body.data.id);
      assertEquals(body.data.user1_id < body.data.user2_id, true);
    } finally {
      await cleanup(userA, userB);
    }
  },
});

Deno.test({
  name: "messages route: POST /conversations 已有会话返回 200",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    try {
      const app = createApp();
      const token = await getToken(userA);
      // 首次创建
      await app.request(BASE, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ other_user_id: userB }),
      });
      // 再次创建
      const res2 = await app.request(BASE, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ other_user_id: userB }),
      });
      assertEquals(res2.status, 200);
    } finally {
      await cleanup(userA, userB);
    }
  },
});

Deno.test({
  name: "messages route: POST /conversations 缺少 other_user_id 返回 400",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const user = await createTestUser();
    try {
      const app = createApp();
      const token = await getToken(user);
      const res = await app.request(BASE, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      assertEquals(res.status, 400);
      const body = await res.json();
      assertEquals(body.error, "缺少对方用户 ID");
    } finally {
      await cleanup(user);
    }
  },
});

Deno.test({
  name: "messages route: POST /conversations 自聊返回 400",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const user = await createTestUser();
    try {
      const app = createApp();
      const token = await getToken(user);
      const res = await app.request(BASE, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ other_user_id: user }),
      });
      assertEquals(res.status, 400);
    } finally {
      await cleanup(user);
    }
  },
});

Deno.test({
  name: "messages route: POST /conversations 对方不存在返回 404",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const user = await createTestUser();
    try {
      const app = createApp();
      const token = await getToken(user);
      const res = await app.request(BASE, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ other_user_id: crypto.randomUUID() }),
      });
      assertEquals(res.status, 404);
    } finally {
      await cleanup(user);
    }
  },
});

Deno.test({
  name: "messages route: GET /conversations 空列表",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const user = await createTestUser();
    try {
      const app = createApp();
      const token = await getToken(user);
      const res = await app.request(BASE, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.data.length, 0);
    } finally {
      await cleanup(user);
    }
  },
});

Deno.test({
  name: "messages route: GET /conversations 非空列表",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    try {
      const app = createApp();
      const token = await getToken(userA);
      // 先创建会话
      await app.request(BASE, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ other_user_id: userB }),
      });
      const res = await app.request(BASE, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.data.length, 1);
      assertEquals(body.data[0].other_user_id, userB);
      assertExists(body.data[0].other_user_name);
      assertExists(body.data[0].last_message_at);
    } finally {
      await cleanup(userA, userB);
    }
  },
});


// ─── Unread Count ────────────────────────────────────────────────

Deno.test({
  name: "messages route: GET /conversations/unread-count 无未读返回 0",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const user = await createTestUser();
    try {
      const app = createApp();
      const token = await getToken(user);
      const res = await app.request(BASE + "/unread-count", {
        headers: { Authorization: `Bearer ${token}` },
      });
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.unread_count, 0);
    } finally {
      await cleanup(user);
    }
  },
});

Deno.test({
  name: "messages route: GET /conversations/unread-count 有未读 > 0",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    try {
      const app = createApp();
      const tokenA = await getToken(userA);
      const tokenB = await getToken(userB);
      // 创建会话
      const createRes = await app.request(BASE, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenA}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ other_user_id: userB }),
      });
      const conv = (await createRes.json()).data;
      // A 发消息
      await app.request(BASE + `/${conv.id}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenA}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: "hello" }),
      });
      // B 查未读
      const res = await app.request(BASE + "/unread-count", {
        headers: { Authorization: `Bearer ${tokenB}` },
      });
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.unread_count, 1);
    } finally {
      await cleanup(userA, userB);
    }
  },
});

// ─── Message 端点 ────────────────────────────────────────────────

Deno.test({
  name: "messages route: POST /conversations/:id/messages 发送成功",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    try {
      const app = createApp();
      const token = await getToken(userA);
      const createRes = await app.request(BASE, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ other_user_id: userB }),
      });
      const conv = (await createRes.json()).data;
      const res = await app.request(BASE + `/${conv.id}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: "Test message" }),
      });
      assertEquals(res.status, 201);
      const body = await res.json();
      assertEquals(body.data.content, "Test message");
      assertEquals(body.data.sender_id, userA);
    } finally {
      await cleanup(userA, userB);
    }
  },
});

Deno.test({
  name: "messages route: POST /conversations/:id/messages 空内容返回 400",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    try {
      const app = createApp();
      const token = await getToken(userA);
      const createRes = await app.request(BASE, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ other_user_id: userB }),
      });
      const conv = (await createRes.json()).data;
      const res = await app.request(BASE + `/${conv.id}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: "   " }),
      });
      assertEquals(res.status, 400);
    } finally {
      await cleanup(userA, userB);
    }
  },
});

Deno.test({
  name: "messages route: POST /conversations/:id/messages 非参与者返回 404",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    const userC = await createTestUser();
    try {
      const app = createApp();
      const tokenA = await getToken(userA);
      const tokenC = await getToken(userC);
      const createRes = await app.request(BASE, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenA}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ other_user_id: userB }),
      });
      const conv = (await createRes.json()).data;
      const res = await app.request(BASE + `/${conv.id}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenC}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: "hi" }),
      });
      assertEquals(res.status, 404);
    } finally {
      await cleanup(userA, userB, userC);
    }
  },
});

Deno.test({
  name: "messages route: POST /conversations/:id/messages 不存在会话返回 404",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const user = await createTestUser();
    try {
      const app = createApp();
      const token = await getToken(user);
      const res = await app.request(BASE + `/${crypto.randomUUID()}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: "hi" }),
      });
      assertEquals(res.status, 404);
    } finally {
      await cleanup(user);
    }
  },
});

Deno.test({
  name: "messages route: GET /conversations/:id/messages 消息列表",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    try {
      const app = createApp();
      const tokenA = await getToken(userA);
      const createRes = await app.request(BASE, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenA}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ other_user_id: userB }),
      });
      const conv = (await createRes.json()).data;
      // 发两条消息
      await app.request(BASE + `/${conv.id}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenA}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: "msg1" }),
      });
      await app.request(BASE + `/${conv.id}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenA}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: "msg2" }),
      });
      // A 查消息
      const res = await app.request(BASE + `/${conv.id}/messages`, {
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.data.length, 2);
      assertExists(body.pagination);
    } finally {
      await cleanup(userA, userB);
    }
  },
});

Deno.test({
  name: "messages route: GET /conversations/:id/messages 不存在会话返回 404",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const user = await createTestUser();
    try {
      const app = createApp();
      const token = await getToken(user);
      const res = await app.request(BASE + `/${crypto.randomUUID()}/messages`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assertEquals(res.status, 404);
    } finally {
      await cleanup(user);
    }
  },
});


// ─── Read / Mark as Read ──────────────────────────────────────────

Deno.test({
  name: "messages route: POST /conversations/:id/read 标记已读返回 204",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    try {
      const app = createApp();
      const tokenA = await getToken(userA);
      const tokenB = await getToken(userB);
      const createRes = await app.request(BASE, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenA}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ other_user_id: userB }),
      });
      const conv = (await createRes.json()).data;
      // A 发消息
      const msgRes = await app.request(BASE + `/${conv.id}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenA}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: "hello" }),
      });
      const msg = (await msgRes.json()).data;
      // B 标记已读
      const res = await app.request(BASE + `/${conv.id}/read`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenB}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ last_read_message_id: msg.id }),
      });
      assertEquals(res.status, 204);
    } finally {
      await cleanup(userA, userB);
    }
  },
});

Deno.test({
  name: "messages route: POST /conversations/:id/read 缺少 last_read_message_id 返回 400",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    try {
      const app = createApp();
      const tokenA = await getToken(userA);
      const createRes = await app.request(BASE, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenA}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ other_user_id: userB }),
      });
      const conv = (await createRes.json()).data;
      const res = await app.request(BASE + `/${conv.id}/read`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenA}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      assertEquals(res.status, 400);
    } finally {
      await cleanup(userA, userB);
    }
  },
});

Deno.test({
  name: "messages route: 已读后未读计数归零",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    try {
      const app = createApp();
      const tokenA = await getToken(userA);
      const tokenB = await getToken(userB);
      const createRes = await app.request(BASE, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenA}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ other_user_id: userB }),
      });
      const conv = (await createRes.json()).data;
      const msgRes = await app.request(BASE + `/${conv.id}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenA}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: "hello" }),
      });
      const msg = (await msgRes.json()).data;
      // B 标记已读后查未读
      await app.request(BASE + `/${conv.id}/read`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenB}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ last_read_message_id: msg.id }),
      });
      const unreadRes = await app.request(BASE + `/${conv.id}/unread-count`, {
        headers: { Authorization: `Bearer ${tokenB}` },
      });
      const unreadBody = await unreadRes.json();
      assertEquals(unreadBody.unread_count, 0);
    } finally {
      await cleanup(userA, userB);
    }
  },
});

// ─── Delete Message ─────────────────────────────────────────────

Deno.test({
  name: "messages route: DELETE /conversations/:id/messages/:mid 删除成功返回 204",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    try {
      const app = createApp();
      const tokenA = await getToken(userA);
      const createRes = await app.request(BASE, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenA}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ other_user_id: userB }),
      });
      const conv = (await createRes.json()).data;
      const msgRes = await app.request(BASE + `/${conv.id}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenA}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: "delete me" }),
      });
      const msg = (await msgRes.json()).data;
      const res = await app.request(BASE + `/${conv.id}/messages/${msg.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      assertEquals(res.status, 204);
    } finally {
      await cleanup(userA, userB);
    }
  },
});

Deno.test({
  name: "messages route: DELETE /conversations/:id/messages/:mid 不存在返回 404",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    try {
      const app = createApp();
      const tokenA = await getToken(userA);
      const createRes = await app.request(BASE, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenA}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ other_user_id: userB }),
      });
      const conv = (await createRes.json()).data;
      const res = await app.request(BASE + `/${conv.id}/messages/${crypto.randomUUID()}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      assertEquals(res.status, 404);
    } finally {
      await cleanup(userA, userB);
    }
  },
});

// ─── 删除消息不删除对方视角 ────────────────────────────────────────

Deno.test({
  name: "messages route: A 删除消息后 A 不可见但 B 仍可见",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    try {
      const app = createApp();
      const tokenA = await getToken(userA);
      const tokenB = await getToken(userB);
      const createRes = await app.request(BASE, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenA}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ other_user_id: userB }),
      });
      const conv = (await createRes.json()).data;
      const msgRes = await app.request(BASE + `/${conv.id}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenA}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: "shared msg" }),
      });
      const msg = (await msgRes.json()).data;
      // A 删除
      await app.request(BASE + `/${conv.id}/messages/${msg.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      // A 看不到
      const resA = await app.request(BASE + `/${conv.id}/messages`, {
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      const bodyA = await resA.json();
      assertEquals(bodyA.data.length, 0);
      // B 仍能看到
      const resB = await app.request(BASE + `/${conv.id}/messages`, {
        headers: { Authorization: `Bearer ${tokenB}` },
      });
      const bodyB = await resB.json();
      assertEquals(bodyB.data.length, 1);
    } finally {
      await cleanup(userA, userB);
    }
  },
});
