import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq, or } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import {
  conversations,
  userBans,
  users,
} from "../../../../shared/db/schema.ts";
import { hashPassword } from "../../../identity/index.ts";
import {
  addReaction,
  deleteMessage,
  editMessage,
  findOrCreateConversation,
  getUnreadCount,
  getUnreadCountByConversation,
  listConversations,
  listMessages,
  markConversationRead,
  recallMessage,
  removeReaction,
  sendMessage,
} from "../../index.ts";
import {
  BadRequestError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";

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
      const { conversation: conv } = await findOrCreateConversation(
        userA,
        userB,
      );
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
      const { conversation: conv1 } = await findOrCreateConversation(
        userA,
        userB,
      );
      const { conversation: conv2 } = await findOrCreateConversation(
        userA,
        userB,
      );
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
      const { conversation: conv } = await findOrCreateConversation(
        userA,
        userB,
      );
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
      const { conversation: conv } = await findOrCreateConversation(
        userA,
        userB,
      );
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
      const { conversation: conv } = await findOrCreateConversation(
        userA,
        userB,
      );
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
      const { conversation: conv } = await findOrCreateConversation(
        userA,
        userB,
      );
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
      const { conversation: conv } = await findOrCreateConversation(
        userA,
        userB,
      );
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
      const { conversation: conv } = await findOrCreateConversation(
        userA,
        userB,
      );
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
  name: "messages: 自己发送的消息不产生未读",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    try {
      const { conversation: conv } = await findOrCreateConversation(
        userA,
        userB,
      );
      await sendMessage(userA, conv.id, "hello from A");

      // A 的会话列表未读数应为 0
      const listA = await listConversations(userA, 1, 20);
      assertEquals(listA.data[0].unread_count, 0);
      assertEquals(await getUnreadCount(userA), 0);
      assertEquals(await getUnreadCountByConversation(userA, conv.id), 0);

      // B 仍未读 1 条
      const listB = await listConversations(userB, 1, 20);
      assertEquals(listB.data[0].unread_count, 1);
      assertEquals(await getUnreadCount(userB), 1);
      assertEquals(await getUnreadCountByConversation(userB, conv.id), 1);
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
      const { conversation: conv } = await findOrCreateConversation(
        userA,
        userB,
      );
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

// ── issue #360：图片消息 / 引用回复 / 转发 / Reaction ──────────

Deno.test({
  name: "messages: 发送图片消息成功（type=image + image_url）",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    try {
      const { conversation: conv } = await findOrCreateConversation(
        userA,
        userB,
      );
      const msg = await sendMessage(userA, conv.id, "", {
        type: "image",
        image_url: "noj-storage://local/msg-img.png",
      });
      assertEquals(msg.type, "image");
      assertEquals(msg.image_url, "noj-storage://local/msg-img.png");
      // 会话列表预览显示 [图片]
      const convs = await listConversations(userB, 1, 20);
      assertEquals(convs.data[0].last_message_preview, "[图片]");
    } finally {
      await cleanup(userA, userB);
    }
  },
});

Deno.test({
  name: "messages: 图片消息缺少 image_url 被拒",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    try {
      const { conversation: conv } = await findOrCreateConversation(
        userA,
        userB,
      );
      await assertRejects(
        () => sendMessage(userA, conv.id, "", { type: "image" }),
        BadRequestError,
      );
    } finally {
      await cleanup(userA, userB);
    }
  },
});

Deno.test({
  name: "messages: 引用回复成功且列表返回 reply_to 摘要",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    try {
      const { conversation: conv } = await findOrCreateConversation(
        userA,
        userB,
      );
      const original = await sendMessage(userA, conv.id, "原始消息");
      const reply = await sendMessage(userB, conv.id, "回复你", {
        reply_to_message_id: original.id,
      });
      assertEquals(reply.reply_to_message_id, original.id);
      const list = await listMessages(userA, conv.id, 1, 50);
      const replyMsg = list.data.find((m) => m.id === reply.id);
      assertEquals(replyMsg?.reply_to?.message_id, original.id);
      assertEquals(replyMsg?.reply_to?.content, "原始消息");
      assertEquals(replyMsg?.reply_to?.sender_id, userA);
    } finally {
      await cleanup(userA, userB);
    }
  },
});

Deno.test({
  name: "messages: 引用其他会话的消息被拒",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    const userC = await createTestUser();
    try {
      const { conversation: convAB } = await findOrCreateConversation(
        userA,
        userB,
      );
      const { conversation: convAC } = await findOrCreateConversation(
        userA,
        userC,
      );
      const msgInAC = await sendMessage(userA, convAC.id, "AC 消息");
      await assertRejects(
        () =>
          sendMessage(userB, convAB.id, "引用", {
            reply_to_message_id: msgInAC.id,
          }),
        BadRequestError,
      );
    } finally {
      await cleanup(userA, userB, userC);
    }
  },
});

Deno.test({
  name: "messages: 转发消息快照复制并标记来源用户",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    const userC = await createTestUser();
    try {
      const { conversation: convAB } = await findOrCreateConversation(
        userA,
        userB,
      );
      const { conversation: convAC } = await findOrCreateConversation(
        userA,
        userC,
      );
      const original = await sendMessage(userB, convAB.id, "B 发给 A 的消息");
      // A 把 AB 会话的消息转发到 AC 会话
      const fwd = await sendMessage(userA, convAC.id, "占位", {
        forwarded_from_message_id: original.id,
      });
      assertEquals(fwd.forwarded_from_user_id, userB);
      assertEquals(fwd.content, "B 发给 A 的消息");
      const list = await listMessages(userC, convAC.id, 1, 50);
      const fwdMsg = list.data.find((m) => m.id === fwd.id);
      assertEquals(fwdMsg?.forwarded_from_user?.id, userB);
      assertEquals(
        fwdMsg?.forwarded_from_user?.username.startsWith("msg_test_"),
        true,
      );
    } finally {
      await cleanup(userA, userB, userC);
    }
  },
});

Deno.test({
  name: "messages: 转发已转发的消息保留原始来源",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    const userC = await createTestUser();
    const userD = await createTestUser();
    try {
      const { conversation: convAB } = await findOrCreateConversation(
        userA,
        userB,
      );
      const { conversation: convAC } = await findOrCreateConversation(
        userA,
        userC,
      );
      const { conversation: convAD } = await findOrCreateConversation(
        userA,
        userD,
      );
      // B 发原始消息，A 转发到 AC，再转发到 AD
      const original = await sendMessage(userB, convAB.id, "原始消息");
      const fwd1 = await sendMessage(userA, convAC.id, "占位", {
        forwarded_from_message_id: original.id,
      });
      const fwd2 = await sendMessage(userA, convAD.id, "占位", {
        forwarded_from_message_id: fwd1.id,
      });
      // 二次转发应保留原始来源 B，而非第一次转发者 A
      assertEquals(fwd2.forwarded_from_user_id, userB);
    } finally {
      await cleanup(userA, userB, userC, userD);
    }
  },
});

Deno.test({
  name: "messages: 转发不可信消息被拒（非参与者）",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    const userC = await createTestUser();
    try {
      const { conversation: convAB } = await findOrCreateConversation(
        userA,
        userB,
      );
      const { conversation: convAC } = await findOrCreateConversation(
        userA,
        userC,
      );
      const msgInAB = await sendMessage(userA, convAB.id, "AB 消息");
      // C 不在 AB 会话中，转发应被拒
      await assertRejects(
        () =>
          sendMessage(userC, convAC.id, "转发", {
            forwarded_from_message_id: msgInAB.id,
          }),
        NotFoundError,
      );
    } finally {
      await cleanup(userA, userB, userC);
    }
  },
});

Deno.test({
  name: "messages: 添加/替换/取消 Reaction",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    try {
      const { conversation: conv } = await findOrCreateConversation(
        userA,
        userB,
      );
      const msg = await sendMessage(userA, conv.id, "带反应的消息");
      await addReaction(userB, conv.id, msg.id, "👍");
      let list = await listMessages(userA, conv.id, 1, 50);
      let reactions = list.data[0].reactions;
      assertEquals(reactions.length, 1);
      assertEquals(reactions[0].emoji, "👍");
      assertEquals(reactions[0].count, 1);
      assertEquals(reactions[0].reacted_by_me, false);
      // 同一用户再点 ❤️：多个不同 emoji 共存
      await addReaction(userB, conv.id, msg.id, "❤️");
      list = await listMessages(userA, conv.id, 1, 50);
      reactions = list.data[0].reactions;
      assertEquals(reactions.length, 2);
      assertEquals(reactions.map((r) => r.emoji).sort(), ["❤️", "👍"]);
      // 取消指定 emoji：仅移除该 emoji
      await removeReaction(userB, conv.id, msg.id, "👍");
      list = await listMessages(userA, conv.id, 1, 50);
      reactions = list.data[0].reactions;
      assertEquals(reactions.length, 1);
      assertEquals(reactions[0].emoji, "❤️");
      await removeReaction(userB, conv.id, msg.id, "❤️");
      list = await listMessages(userA, conv.id, 1, 50);
      assertEquals(list.data[0].reactions.length, 0);
    } finally {
      await cleanup(userA, userB);
    }
  },
});

Deno.test({
  name: "messages: 非法 emoji 被拒",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    try {
      const { conversation: conv } = await findOrCreateConversation(
        userA,
        userB,
      );
      const msg = await sendMessage(userA, conv.id, "消息");
      await assertRejects(
        () => addReaction(userB, conv.id, msg.id, "🚫"),
        BadRequestError,
      );
    } finally {
      await cleanup(userA, userB);
    }
  },
});

Deno.test({
  name: "messages: 对方已读后自己发送的消息 read=true",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    try {
      const { conversation: conv } = await findOrCreateConversation(
        userA,
        userB,
      );
      const msg = await sendMessage(userA, conv.id, "待读消息");
      // 未读时 read=false
      let list = await listMessages(userA, conv.id, 1, 50);
      assertEquals(list.data[0].read, false);
      // B 标记已读
      await markConversationRead(userB, conv.id, msg.id);
      list = await listMessages(userA, conv.id, 1, 50);
      assertEquals(list.data[0].read, true);
    } finally {
      await cleanup(userA, userB);
    }
  },
});

// ── 审查回归：转发图片消息 type 同步 / image_url 格式校验 / 已读跨会话 ──

Deno.test({
  name: "messages: 转发图片消息时 type 同步为 image",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    const userC = await createTestUser();
    try {
      const { conversation: convAB } = await findOrCreateConversation(
        userA,
        userB,
      );
      const { conversation: convAC } = await findOrCreateConversation(
        userA,
        userC,
      );
      const img = await sendMessage(userA, convAB.id, "", {
        type: "image",
        image_url: "noj-storage://local/msg-img.png",
      });
      // 转发图片消息：不传 type，服务端应从原消息同步
      const fwd = await sendMessage(userA, convAC.id, "", {
        forwarded_from_message_id: img.id,
      });
      assertEquals(fwd.type, "image");
      assertEquals(fwd.image_url, "noj-storage://local/msg-img.png");
      assertEquals(fwd.forwarded_from_user_id, userA);
    } finally {
      await cleanup(userA, userB, userC);
    }
  },
});

Deno.test({
  name: "messages: 图片消息 image_url 非存储 URL 被拒",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    try {
      const { conversation: conv } = await findOrCreateConversation(
        userA,
        userB,
      );
      await assertRejects(
        () =>
          sendMessage(userA, conv.id, "", {
            type: "image",
            image_url: "https://evil.example/x.png",
          }),
        BadRequestError,
      );
      await assertRejects(
        () =>
          sendMessage(userA, conv.id, "", {
            type: "image",
            image_url: "data:image/png;base64,AAAA",
          }),
        BadRequestError,
      );
    } finally {
      await cleanup(userA, userB);
    }
  },
});

Deno.test({
  name: "messages: 已读位置跨会话消息被拒",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    const userC = await createTestUser();
    try {
      const { conversation: convAB } = await findOrCreateConversation(
        userA,
        userB,
      );
      const { conversation: convAC } = await findOrCreateConversation(
        userA,
        userC,
      );
      const msgInAC = await sendMessage(userA, convAC.id, "AC 消息");
      // B 在 AB 会话中标记已读位置为 AC 会话的消息 → 拒绝
      await assertRejects(
        () => markConversationRead(userB, convAB.id, msgInAC.id),
        BadRequestError,
      );
    } finally {
      await cleanup(userA, userB, userC);
    }
  },
});

Deno.test({
  name: "messages: 编辑消息（5 分钟内，仅发送者，仅文本）",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    try {
      const { conversation: conv } = await findOrCreateConversation(
        userA,
        userB,
      );
      const msg = await sendMessage(userA, conv.id, "原始内容");
      await editMessage(userA, conv.id, msg.id, "编辑后内容");
      const list = await listMessages(userB, conv.id, 1, 50);
      const edited = list.data.find((m) => m.id === msg.id);
      assertEquals(edited?.content, "编辑后内容");
      assertEquals(edited?.edited_at != null, true);
      // 非发送者编辑 → 拒绝
      await assertRejects(
        () => editMessage(userB, conv.id, msg.id, "越权编辑"),
        BadRequestError,
      );
    } finally {
      await cleanup(userA, userB);
    }
  },
});

Deno.test({
  name: "messages: 撤回消息（2 分钟内，仅发送者）",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    try {
      const { conversation: conv } = await findOrCreateConversation(
        userA,
        userB,
      );
      const msg = await sendMessage(userA, conv.id, "待撤回");
      await recallMessage(userA, conv.id, msg.id);
      const list = await listMessages(userB, conv.id, 1, 50);
      const recalled = list.data.find((m) => m.id === msg.id);
      assertEquals(recalled?.recalled_at != null, true);
      // 撤回后普通参与者不应再拿到原文
      assertEquals(recalled?.content, "该消息已撤回");
      // 非发送者撤回 → 拒绝
      await assertRejects(
        () => recallMessage(userB, conv.id, msg.id),
        BadRequestError,
      );
    } finally {
      await cleanup(userA, userB);
    }
  },
});

Deno.test({
  name: "messages: 已撤回消息不可转发/引用/Reaction",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    const userC = await createTestUser();
    try {
      const { conversation: convAB } = await findOrCreateConversation(
        userA,
        userB,
      );
      const { conversation: convAC } = await findOrCreateConversation(
        userA,
        userC,
      );
      const msg = await sendMessage(userB, convAB.id, "待撤回");
      await recallMessage(userB, convAB.id, msg.id);
      // 转发已撤回消息被拒
      await assertRejects(
        () =>
          sendMessage(userA, convAC.id, "转发", {
            forwarded_from_message_id: msg.id,
          }),
        BadRequestError,
      );
      // 引用已撤回消息被拒
      await assertRejects(
        () =>
          sendMessage(userA, convAB.id, "引用", {
            reply_to_message_id: msg.id,
          }),
        BadRequestError,
      );
      // 对已撤回消息添加 Reaction 被拒
      await assertRejects(
        () => addReaction(userA, convAB.id, msg.id, "👍"),
        BadRequestError,
      );
    } finally {
      await cleanup(userA, userB, userC);
    }
  },
});

Deno.test({
  name: "messages: 社交封禁用户不可私聊（发送/创建会话均拦截）",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const bannedUser = await createTestUser();
    const otherUser = await createTestUser();
    try {
      // 先创建会话并发送一条消息（未封禁时正常）
      const { conversation } = await findOrCreateConversation(
        bannedUser,
        otherUser,
      );
      await sendMessage(bannedUser, conversation.id, "封禁前的消息");

      // 施加 social 封禁
      const now = new Date().toISOString();
      await getDb().insert(userBans).values({
        id: crypto.randomUUID(),
        user_id: bannedUser,
        reason: "举报封禁测试",
        scope: "social",
        banned_at: now,
        banned_by: otherUser,
      });

      // 发送消息被拦截
      await assertRejects(
        () => sendMessage(bannedUser, conversation.id, "封禁后消息"),
        BadRequestError,
      );
      // 创建新会话被拦截
      await assertRejects(
        () => findOrCreateConversation(bannedUser, otherUser),
        BadRequestError,
      );
    } finally {
      await cleanup(bannedUser, otherUser);
    }
  },
});
