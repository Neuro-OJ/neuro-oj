import { assertEquals } from "jsr:@std/assert@^1";
import { and, eq } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import {
  contentReviewQueue,
  conversations,
  messages,
  users,
} from "../../src/db/schema.ts";
import { hashPassword } from "../../src/lib/password.ts";
import {
  enterTestContext,
  leaveTestContext,
} from "../../src/lib/requestContext.ts";
import {
  _resetSystemSettingsForTest,
  ensureRbacSeeds,
  initSystemSettings,
  updateSetting,
} from "../../src/domains/system/index.ts";
import {
  _setReviewProviderFactoryForTest,
  decideReview,
  enqueueDmMessageReview,
  enqueueReview,
  listReviewQueue,
  resolveReviewQueue,
  type ReviewRuntimeConfig,
  runContentReview,
  withReviewTimeout,
} from "../../src/domains/content-review/index.ts";
import { MockReviewProvider } from "../../src/domains/content-review/providers/mock.ts";
import { ForbiddenError } from "../../src/lib/errors.ts";
import { reviewUgcContent } from "../../src/domains/community/services/community/community-review.ts";

// 模块级 bootstrap：确保 PGlite schema 已创建
await resetDbForTest();

const hasEnv = !!Deno.env.get("JWT_SECRET");

async function createTestUser(usernamePrefix: string): Promise<string> {
  const db = getDb();
  const id = crypto.randomUUID();
  const unique = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  await db.insert(users).values({
    id,
    username: `${usernamePrefix}_${unique}`,
    email: `${usernamePrefix}_${unique}@test.com`,
    password_hash: await hashPassword("TestPass123"),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  return id;
}

/** 测试配置：总开关开 + 默认阈值。 */
function reviewConfig(): ReviewRuntimeConfig {
  return {
    enabled: true,
    providerName: "mock",
    riskThreshold: 80,
    reviewThreshold: 50,
    asyncEnabled: true,
    timeoutMs: 1000,
  };
}

/** 注入固定 verdict 的 mock provider。 */
function providerReturning(
  verdict: "pass" | "review" | "block",
): MockReviewProvider {
  return new MockReviewProvider({
    custom: () => ({
      verdict,
      riskLevel: verdict === "block"
        ? "high"
        : verdict === "review"
        ? "medium"
        : "low",
      score: verdict === "block" ? 95 : verdict === "review" ? 60 : 0,
      provider: "mock",
    }),
  });
}

Deno.test({
  name: "content-review: Mock provider 命中词判定",
  ignore: !hasEnv,
  fn: async () => {
    const provider = new MockReviewProvider({
      blockWords: ["违禁词A"],
      reviewWords: ["疑似词B"],
    });
    const block = await provider.reviewText("这里有违禁词A", {
      content_type: "post",
    });
    assertEquals(block.verdict, "block");
    assertEquals(block.hitWords, ["违禁词A"]);

    const review = await provider.reviewText("可能有疑似词B", {
      content_type: "message",
    });
    assertEquals(review.verdict, "review");

    const pass = await provider.reviewText("正常内容", {
      content_type: "comment",
    });
    assertEquals(pass.verdict, "pass");
  },
});

Deno.test({
  name: "content-review: decideReview 阈值归一化",
  ignore: !hasEnv,
  fn: () => {
    const cfg = reviewConfig();
    // 明确 block 且分数达标 → block
    assertEquals(
      decideReview({ verdict: "block", score: 95, provider: "mock" }, cfg)
        .action,
      "block",
    );
    // 明确 block 但分数低于拦截阈值 → 降级转人工
    assertEquals(
      decideReview({ verdict: "block", score: 40, provider: "mock" }, cfg)
        .action,
      "review",
    );
    // review → review
    assertEquals(
      decideReview({ verdict: "review", provider: "mock" }, cfg).action,
      "review",
    );
    // 无明确 verdict 但有分数：≥ riskThreshold → block
    assertEquals(
      decideReview({ verdict: "pass", score: 90, provider: "mock" }, cfg)
        .action,
      "block",
    );
    // 分数介于两阈值 → review
    assertEquals(
      decideReview({ verdict: "pass", score: 60, provider: "mock" }, cfg)
        .action,
      "review",
    );
    // 分数低 → pass
    assertEquals(
      decideReview({ verdict: "pass", score: 10, provider: "mock" }, cfg)
        .action,
      "pass",
    );
    // error → review（fail-open 转人工）
    assertEquals(
      decideReview({ verdict: "error", provider: "mock" }, cfg).action,
      "review",
    );
  },
});

Deno.test({
  name: "content-review: withReviewTimeout 超时返回 null",
  ignore: !hasEnv,
  fn: async () => {
    const slow = new Promise<string>((resolve) =>
      setTimeout(resolve, 200, "x")
    );
    const timedOut = await withReviewTimeout(slow, 10);
    assertEquals(timedOut, null);
    const fast = await withReviewTimeout(Promise.resolve("ok"), 100);
    assertEquals(fast, "ok");
  },
});

Deno.test({
  name: "content-review: enqueueReview 落库 + 同目标去重 + 审计",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await ensureRbacSeeds();
    _resetSystemSettingsForTest();
    await initSystemSettings();
    const moderatorId = await createTestUser("cr_mod");
    enterTestContext({
      actorId: "0",
      actorIp: "127.0.0.1",
      actorRole: "admin",
    });
    try {
      const first = await enqueueReview({
        content_type: "post",
        target_id: "target-1",
        channel: "ugc",
        status: "pending_review",
        review_provider: "mock",
        verdict: "review",
        label: ["疑似违规"],
        content_snapshot: "快照内容",
        meta: { author_id: "u1" },
      });
      assertEquals(first?.status, "pending_review");

      // 同 target 已有 pending_review → 去重返回 null
      const dup = await enqueueReview({
        content_type: "post",
        target_id: "target-1",
        channel: "ugc",
        status: "pending_review",
        review_provider: "mock",
        verdict: "review",
      });
      assertEquals(dup, null);

      // 列表查询
      const list = await listReviewQueue({
        status: "pending_review",
        page: 1,
        perPage: 10,
      });
      assertEquals(list.total, 1);

      // 人工处置 → reviewed + action_taken
      const resolved = await resolveReviewQueue(
        first!.id,
        moderatorId,
        "reviewed",
        "record_only",
        "已复核，无进一步处理",
      );
      assertEquals(resolved.status, "reviewed");
      assertEquals(resolved.action_taken, "record_only");

      // 处置后同 target 可再次入队（无 pending 残留）
      const after = await enqueueReview({
        content_type: "post",
        target_id: "target-1",
        channel: "ugc",
        status: "pending_review",
        review_provider: "mock",
        verdict: "review",
      });
      assertEquals(after?.status, "pending_review");
    } finally {
      leaveTestContext();
    }
  },
});

Deno.test({
  name: "content-review: runContentReview block → rejected + block outcome",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await ensureRbacSeeds();
    _resetSystemSettingsForTest();
    await initSystemSettings();
    try {
      await updateSetting("content_review_enabled", true, "0");
      await updateSetting("content_review_provider", "mock", "0");
      _setReviewProviderFactoryForTest(() => providerReturning("block"));

      const outcome = await runContentReview({
        content_type: "post",
        target_id: "blk-post-1",
        channel: "ugc",
        text: "违规文本",
        enabled: true,
      });
      assertEquals(outcome.action, "block");

      const rows = await getDb().select().from(contentReviewQueue).where(
        and(
          eq(contentReviewQueue.target_id, "blk-post-1"),
          eq(contentReviewQueue.status, "rejected"),
        ),
      );
      assertEquals(rows.length, 1);
      assertEquals(rows[0]?.verdict, "block");
    } finally {
      _setReviewProviderFactoryForTest(null);
    }
  },
});

Deno.test({
  name: "content-review: runContentReview 疑似 → 放行 + pending_review",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await ensureRbacSeeds();
    _resetSystemSettingsForTest();
    await initSystemSettings();
    try {
      await updateSetting("content_review_enabled", true, "0");
      await updateSetting("content_review_provider", "mock", "0");
      _setReviewProviderFactoryForTest(() => providerReturning("review"));

      const outcome = await runContentReview({
        content_type: "comment",
        target_id: "rv-cmt-1",
        channel: "ugc",
        text: "疑似文本",
        enabled: true,
      });
      assertEquals(outcome.action, "review");

      const rows = await getDb().select().from(contentReviewQueue).where(
        eq(contentReviewQueue.target_id, "rv-cmt-1"),
      );
      assertEquals(rows.length, 1);
      assertEquals(rows[0]?.status, "pending_review");
    } finally {
      _setReviewProviderFactoryForTest(null);
    }
  },
});

Deno.test({
  name: "content-review: runContentReview Provider 异常 → fail-open 转人工",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await ensureRbacSeeds();
    _resetSystemSettingsForTest();
    await initSystemSettings();
    try {
      await updateSetting("content_review_enabled", true, "0");
      _setReviewProviderFactoryForTest(() => ({
        name: "boom",
        reviewText: () => Promise.reject(new Error("provider down")),
      }));

      const outcome = await runContentReview({
        content_type: "post",
        target_id: "failopen-1",
        channel: "ugc",
        text: "任意文本",
        enabled: true,
      });
      // fail-open：不阻断，转人工
      assertEquals(outcome.action, "review");

      const rows = await getDb().select().from(contentReviewQueue).where(
        eq(contentReviewQueue.target_id, "failopen-1"),
      );
      assertEquals(rows[0]?.status, "pending_review");
      assertEquals(rows[0]?.verdict, "error");
    } finally {
      _setReviewProviderFactoryForTest(null);
    }
  },
});

Deno.test({
  name: "content-review: 总开关关闭时 runContentReview 直通不入库",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await ensureRbacSeeds();
    _resetSystemSettingsForTest();
    await initSystemSettings();
    try {
      await updateSetting("content_review_enabled", false, "0");
      _setReviewProviderFactoryForTest(() => providerReturning("block"));
      const outcome = await runContentReview({
        content_type: "post",
        target_id: "disabled-1",
        channel: "ugc",
        text: "违规文本",
        enabled: true,
      });
      assertEquals(outcome.action, "pass");
      const count = await getDb().select().from(contentReviewQueue).where(
        eq(contentReviewQueue.target_id, "disabled-1"),
      );
      assertEquals(count.length, 0);
    } finally {
      _setReviewProviderFactoryForTest(null);
    }
  },
});

Deno.test({
  name:
    "content-review: reviewUgcContent block 抛 CONTENT_REVIEW_REJECTED；review 放行",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await ensureRbacSeeds();
    _resetSystemSettingsForTest();
    await initSystemSettings();
    try {
      await updateSetting("content_review_enabled", true, "0");
      _setReviewProviderFactoryForTest(() => providerReturning("block"));
      try {
        await reviewUgcContent({
          content_type: "post",
          target_id: "ugc-block-1",
          title: "标题",
          content: "内容",
          author_id: "u-1",
          finalStatus: "published",
        });
        throw new Error("应当抛出 CONTENT_REVIEW_REJECTED");
      } catch (err) {
        if (!(err instanceof ForbiddenError)) throw err;
        assertEquals(err.code, "CONTENT_REVIEW_REJECTED");
      }

      // pending 内容（新用户审核期已有）→ block 不拦截
      _setReviewProviderFactoryForTest(() => providerReturning("block"));
      await reviewUgcContent({
        content_type: "post",
        target_id: "ugc-pending-1",
        content: "内容",
        author_id: "u-1",
        finalStatus: "pending",
      });

      // 疑似 → 放行
      _setReviewProviderFactoryForTest(() => providerReturning("review"));
      await reviewUgcContent({
        content_type: "comment",
        target_id: "ugc-review-1",
        content: "疑似内容",
        author_id: "u-1",
        finalStatus: "published",
      });

      // moderator 跳过
      _setReviewProviderFactoryForTest(() => providerReturning("block"));
      await reviewUgcContent({
        content_type: "post",
        target_id: "ugc-mod-1",
        content: "违规",
        author_id: "u-1",
        moderator: true,
        finalStatus: "published",
      });
    } finally {
      _setReviewProviderFactoryForTest(null);
    }
  },
});

Deno.test({
  name: "content-review: enqueueDmMessageReview 开关关闭/Redis 不可用均不抛错",
  ignore: !hasEnv,
  fn: async () => {
    await resetDbForTest();
    await ensureRbacSeeds();
    _resetSystemSettingsForTest();
    await initSystemSettings();
    enterTestContext({
      actorId: "0",
      actorIp: "127.0.0.1",
      actorRole: "admin",
    });
    try {
      // 总开关关闭 → 直接返回 false
      await updateSetting("content_review_enabled", false, "0");
      const off = await enqueueDmMessageReview({
        message_id: "m-1",
        conversation_id: "c-1",
        sender_id: "s-1",
        content: "hi",
        created_at: new Date().toISOString(),
      });
      assertEquals(off, false);
    } finally {
      leaveTestContext();
    }
  },
});

Deno.test({
  name: "content-review: 私信异步消息文本处理（直接 handler 层，不依赖 Redis）",
  ignore: !hasEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await ensureRbacSeeds();
    _resetSystemSettingsForTest();
    await initSystemSettings();
    try {
      await updateSetting("content_review_enabled", true, "0");
      await updateSetting("content_review_provider", "mock", "0");
      _setReviewProviderFactoryForTest(() => providerReturning("block"));

      const db = getDb();
      const userA = await createTestUser("cr_a");
      const userB = await createTestUser("cr_b");
      try {
        // 手动构造一条文本消息（绕过 sendMessage 的 SSE/Redis 依赖）
        const msgId = crypto.randomUUID();
        const convId = crypto.randomUUID();
        await db.insert(users).values({
          id: "cr_target_sender",
          username: "cr_target_sender_u",
          email: `cr_target_sender_${Date.now()}@test.com`,
          password_hash: "hash",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        const [u1, u2] = [userA, userB].sort();
        const now = new Date().toISOString();
        await db.insert(conversations).values({
          id: convId,
          user1_id: u1,
          user2_id: u2,
          last_message_at: now,
          created_at: now,
        });
        await db.insert(messages).values({
          id: msgId,
          conversation_id: convId,
          sender_id: "cr_target_sender",
          type: "text",
          content: "这是一段私信违规文本",
          created_at: new Date().toISOString(),
        });

        // 直接调消费者 handler（模拟队列消费）
        const { handleDmReviewMessage } = await import(
          "../../src/mq/review-consumer.ts"
        );
        await handleDmReviewMessage({
          message_id: msgId,
          conversation_id: convId,
          sender_id: "cr_target_sender",
          content: "这是一段私信违规文本",
          created_at: new Date().toISOString(),
        });

        const rows = await db.select().from(contentReviewQueue).where(
          eq(contentReviewQueue.target_id, msgId),
        );
        assertEquals(rows.length, 1);
        assertEquals(rows[0]?.status, "pending_review");
        assertEquals(rows[0]?.channel, "dm");
        assertEquals(rows[0]?.content_type, "message");
      } finally {
        await db.delete(users).where(eq(users.id, "cr_target_sender")).catch(
          () => {},
        );
      }
    } finally {
      _setReviewProviderFactoryForTest(null);
    }
  },
});
