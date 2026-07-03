import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq, and, or } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import { conversations, users } from "../../src/db/schema.ts";
import { hashPassword } from "../../src/lib/password.ts";
import {
  findOrCreateConversation,
  sendMessage,
  listConversations,
  listMessages,
  markConversationRead,
  getUnreadCount,
  getUnreadCountByConversation,
  deleteMessage,
} from "../../src/services/messages.ts";
import { BadRequestError, NotFoundError } from "../../src/lib/errors.ts";

// 模块级 bootstrap：确保 PGlite schema 已创建
await resetDbForTest();

const hasEnv = true && // DATABASE_URL 未设置时 PGlite 可用
  !!Deno.env.get("JWT_SECRET");

/**
 * 创建独立测试用户。
 */
async function createTestUser(): Promise<string> {
  const db = getDb();
  const id = crypto.randomUUID();
  const unique = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  await db.insert(users).values({
    id,
    username: `msg_test_${unique}`,
    email: `msg_test_${unique}@test.com`,
    password_hash: await hashPassword("TestMsgPass1"),
    role: "user",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  return id;
}

/**
 * 清理用户和关联数据。
 * 需先删除关联会话（CASCADE 到 messages/conversation_reads/message_deletions），
 * 再删除用户，避免 conversations.user1_id/user2_id FK 阻止用户删除。
 */
async function cleanup(...userIds: string[]): Promise<void> {
  const db = getDb();
  for (const uid of userIds) {
    // 先删除用户参与的会话（CASCADE 到 messages、conversation_reads、message_deletions）
    await db.delete(conversations).where(
      or(eq(conversations.user1_id, uid), eq(conversations.user2_id, uid)),
    );
    await db.delete(users).where(eq(users.id, uid));
  }
}

Deno.test({
  name: "messages: 创建新会话成功",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    try {
      const { conversation: conv } = await findOrCreateConversation(userA, userB);
      assertEquals(typeof conv.id, "string");
      assertEquals(conv.user1_id, userA < userB ? userA : userB);
      assertEquals(conv.user2_id, userA < userB ? userB : userA);
    } finally {
      await cleanup(userA, userB);
    }
  },
});

Deno.test({
  name: "messages: 已有会话返回相同会话",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    try {
      const { conversation: conv1 } = await findOrCreateConversation(userA, userB);
      const { conversation: conv2 } = await findOrCreateConversation(userA, userB);
      assertEquals(conv1.id, conv2.id);
    } finally {
      await cleanup(userA, userB);
    }
  },
});

Deno.test({
  name: "messages: 拒绝自聊",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const user = await createTestUser();
    try {
      await assertRejects(
        () => findOrCreateConversation(user, user),
        BadRequestError,
        "无法与自己创建会话",
      );
    } finally {
      await cleanup(user);
    }
  },
});

Deno.test({
  name: "messages: 对方用户不存在返回 404",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const user = await createTestUser();
    try {
      await assertRejects(
        () => findOrCreateConversation(user, crypto.randomUUID()),
        NotFoundError,
        "用户不存在",
      );
    } finally {
      await cleanup(user);
    }
  },
});

Deno.test({
  name: "messages: 发送消息成功",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    try {
      const { conversation: conv } = await findOrCreateConversation(userA, userB);
      const msg = await sendMessage(userA, conv.id, "Hello!");
      assertEquals(msg.content, "Hello!");
      assertEquals(msg.sender_id, userA);
    } finally {
      await cleanup(userA, userB);
    }
  },
});

Deno.test({
  name: "messages: 非参与者发送消息被拒",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    const userC = await createTestUser();
    try {
      const { conversation: conv } = await findOrCreateConversation(userA, userB);
      await assertRejects(
        () => sendMessage(userC, conv.id, "Hi"),
        NotFoundError,
      );
    } finally {
      await cleanup(userA, userB, userC);
    }
  },
});

Deno.test({
  name: "messages: 获取会话列表",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    try {
      await findOrCreateConversation(userA, userB);
      const result = await listConversations(userA, 1, 20);
      assertEquals(result.data.length, 1);
      assertEquals(result.data[0].other_user_id, userB);
    } finally {
      await cleanup(userA, userB);
    }
  },
});

Deno.test({
  name: "messages: 空会话列表",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const user = await createTestUser();
    try {
      const result = await listConversations(user, 1, 20);
      assertEquals(result.data.length, 0);
    } finally {
      await cleanup(user);
    }
  },
});

Deno.test({
  name: "messages: 获取消息列表（分页）",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    try {
      const { conversation: conv } = await findOrCreateConversation(userA, userB);
      await sendMessage(userA, conv.id, "msg1");
      await sendMessage(userB, conv.id, "msg2");
      const result = await listMessages(userA, conv.id, 1, 10);
      assertEquals(result.data.length, 2);
    } finally {
      await cleanup(userA, userB);
    }
  },
});

Deno.test({
  name: "messages: 非参与者查看消息被拒",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    const userC = await createTestUser();
    try {
      const { conversation: conv } = await findOrCreateConversation(userA, userB);
      await assertRejects(
        () => listMessages(userC, conv.id, 1, 10),
        NotFoundError,
      );
    } finally {
      await cleanup(userA, userB, userC);
    }
  },
});

Deno.test({
  name: "messages: 标记已读和未读计数",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    try {
      const { conversation: conv } = await findOrCreateConversation(userA, userB);
      const msg1 = await sendMessage(userA, conv.id, "test message");

      // 标记已读前 B 有 1 条未读
      const countBefore = await getUnreadCountByConversation(userB, conv.id);
      assertEquals(countBefore, 1);

      // B 标记已读
      await markConversationRead(userB, conv.id, msg1.id);
      const countAfter = await getUnreadCountByConversation(userB, conv.id);
      assertEquals(countAfter, 0);
    } finally {
      await cleanup(userA, userB);
    }
  },
});

Deno.test({
  name: "messages: 总未读计数",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    try {
      const { conversation: conv } = await findOrCreateConversation(userA, userB);
      await sendMessage(userA, conv.id, "msg1");

      const total = await getUnreadCount(userB);
      // B 在唯一会话中有 1 条未读
      assertEquals(total >= 1, true);
    } finally {
      await cleanup(userA, userB);
    }
  },
});

Deno.test({
  name: "messages: 软删除消息",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    try {
      const { conversation: conv } = await findOrCreateConversation(userA, userB);
      const msg = await sendMessage(userA, conv.id, "delete me");

      // A 删除这条消息
      await deleteMessage(userA, msg.id);

      // A 的列表中不显示
      const resultA = await listMessages(userA, conv.id, 1, 10);
      assertEquals(resultA.data.length, 0);

      // B 仍能看到
      const resultB = await listMessages(userB, conv.id, 1, 10);
      assertEquals(resultB.data.length, 1);
    } finally {
      await cleanup(userA, userB);
    }
  },
});

Deno.test({
  name: "messages: 删除不存在消息返回 404",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const user = await createTestUser();
    try {
      await assertRejects(
        () => deleteMessage(user, crypto.randomUUID()),
        NotFoundError,
      );
    } finally {
      await cleanup(user);
    }
  },
});
