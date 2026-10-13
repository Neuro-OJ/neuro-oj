import { assertEquals } from "jsr:@std/assert@^1";
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { AppError } from "../../../../shared/base/errors.ts";
import {
  communityNotifications,
  conversations,
  messages,
} from "../../../../shared/db/schema.ts";
import { DEFAULT_DOMAIN_ID } from "../../../../shared/workspace/types.ts";
import adminCommunityRouter from "../../../admin/routes/community.ts";
import { createUserToken, jsonRequest } from "../../../../../tests/helper.ts";
import {
  createBoard,
  createComment,
  createPost,
  createReport,
  withDefaultCommunity,
} from "../../index.ts";
import { domainFixture } from "../services/domain-fixture.ts";

const base = "/api/v1/admin/community";

async function fixture() {
  const f = await domainFixture("report-notice");
  const token = await createUserToken("admin");
  const app = new Hono();
  app.route(base, adminCommunityRouter);
  app.onError((error, c) => {
    if (error instanceof AppError) {
      return c.json(
        { error: error.message, code: error.code },
        error.statusCode as 400,
      );
    }
    throw error;
  });
  return { ...f, app, token };
}

async function noticeDomains(
  f: Awaited<ReturnType<typeof fixture>>,
  reportId: string,
) {
  return (await f.db.select({ domain: communityNotifications.domain_id }).from(
    communityNotifications,
  ).where(and(
    eq(communityNotifications.type, "report"),
    sql`${communityNotifications.data}->>'report_id' = ${reportId}`,
  ))).map((row) => row.domain);
}

async function resolveAndReopen(
  f: Awaited<ReturnType<typeof fixture>>,
  reportId: string,
) {
  for (const status of ["resolved", "reopen"]) {
    const response = await jsonRequest(
      f.app,
      `${base}/reports/${reportId}/${status}`,
      {
        token: f.token,
        method: "POST",
        body: { resolution: "审核处理" },
      },
    );
    assertEquals(response.status, 200, status);
  }
}

Deno.test({
  name: "举报通知归属：旧管理处理和重开评论举报均保存 main",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const f = await fixture();
    const board = await withDefaultCommunity(
      "0",
      { write: true, moderator: true },
      (scope) =>
        createBoard({ slug: "report-notice-main", name: "main" }, scope),
    );
    const post = await withDefaultCommunity(
      "0",
      { write: true, moderator: true },
      (scope) =>
        createPost(
          "0",
          {
            type: "discussion",
            board_id: board.id,
            title: "讨论",
            content: "内容",
          },
          true,
          scope,
        ),
    );
    const comment = await withDefaultCommunity(f.a, {
      write: true,
      moderator: true,
    }, (scope) => createComment(f.a, post.id, "评论", undefined, true, scope));
    const report = await createReport(f.student, {
      comment_id: comment.id,
      reason: "评论举报",
      category: "其他",
    });
    assertEquals(report.post_id, null);
    assertEquals(report.domain_id, DEFAULT_DOMAIN_ID);
    assertEquals(await noticeDomains(f, report.id), [DEFAULT_DOMAIN_ID]);
    await resolveAndReopen(f, report.id);
    assertEquals(await noticeDomains(f, report.id), [
      DEFAULT_DOMAIN_ID,
      DEFAULT_DOMAIN_ID,
      DEFAULT_DOMAIN_ID,
    ]);
  },
});

Deno.test({
  name: "举报通知归属：旧管理处理和重开私信举报保持账号空域",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const f = await fixture();
    const conversationId = crypto.randomUUID(), messageId = crypto.randomUUID();
    const [user1, user2] = [f.a, f.student].sort();
    await f.db.insert(conversations).values({
      id: conversationId,
      user1_id: user1,
      user2_id: user2,
      last_message_at: f.now,
      created_at: f.now,
    });
    await f.db.insert(messages).values({
      id: messageId,
      conversation_id: conversationId,
      sender_id: f.a,
      content: "私信",
      created_at: f.now,
    });
    const report = await createReport(f.student, {
      message_id: messageId,
      reason: "私信举报",
      category: "其他",
    });
    assertEquals(report.domain_id, null);
    assertEquals(await noticeDomains(f, report.id), [null]);
    await resolveAndReopen(f, report.id);
    assertEquals(await noticeDomains(f, report.id), [null, null, null]);
  },
});
