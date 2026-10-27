import { assert, assertEquals } from "jsr:@std/assert@^1";
import { Hono } from "hono";
import { AppError } from "../../../../../shared/base/errors.ts";
import { accountNotifications } from "../../../../../shared/db/schema.ts";
import {
  _dispatchToLocalListenersForTest,
  Channels,
} from "../../../../../shared/sse/event-bus.ts";
import { recordSseEvent } from "../../../../../shared/sse/sse-events.ts";
import { signToken } from "../../../../access/identity/index.ts";
import {
  removeDomainMember,
  setMemberRoles,
} from "../../../../access/workspace/index.ts";
import { createComment, withDomainCommunity } from "../../index.ts";
import { accountNotificationRouter } from "../../../../http/account-notifications.ts";
import { domainCommunityRouter } from "../../routes/domain-community.ts";
import { domainFixture } from "../services/domain-fixture.ts";
import { jsonRequest } from "../../../../../../tests/helper.ts";
function app() {
  const app = new Hono();
  app.route("/api/v1", domainCommunityRouter);
  app.route("/api/v1", accountNotificationRouter);
  app.onError((error, c) => {
    if (error instanceof AppError) {
      return c.json(
        { error: error.message, code: error.code },
        error.statusCode as 400,
      );
    }
    throw error;
  });
  return app;
}

Deno.test({
  name: "域社区 HTTP：匿名访问、错误域ID、板块revision和治理角色即时撤销",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const f = await domainFixture("community-http"), application = app();
    const source = `/api/v1/domains/${f.source.slug}/community`,
      target = `/api/v1/domains/${f.target.slug}/community`;
    const owner = await signToken({ sub: f.b, role: "user" }),
      student = await signToken({ sub: f.student, role: "user" });
    const publicBoards = await jsonRequest(application, `${source}/boards`);
    assertEquals(publicBoards.status, 200);
    assertEquals(publicBoards.headers.get("Cache-Control"), "no-store");
    assertEquals(
      (await jsonRequest(application, `${target}/boards`)).status,
      404,
    );
    assertEquals(
      (await jsonRequest(application, `${source}/posts/${f.postB.id}`)).status,
      404,
    );
    const created = await jsonRequest(application, `${target}/posts`, {
      token: student,
      method: "POST",
      body: {
        type: "discussion",
        board_id: f.boardB.id,
        title: "student post",
        content: "student body",
      },
    });
    assertEquals(created.status, 201);
    const post = (await created.json()).data;
    assertEquals(post.domain_id, f.target.id);
    assertEquals(
      (await jsonRequest(application, `${target}/posts`, {
        token: student,
        method: "POST",
        body: {
          type: "discussion",
          board_id: f.boardA.id,
          title: "cross",
          content: "cross",
        },
      })).status,
      404,
    );
    assertEquals(
      (await jsonRequest(application, `${target}/manage/boards`, {
        token: student,
      })).status,
      403,
    );
    await setMemberRoles(f.target.slug, f.b, f.student, ["moderator"]);
    assertEquals(
      (await jsonRequest(application, `${target}/manage/boards`, {
        token: student,
      })).status,
      200,
    );
    assertEquals(
      (await jsonRequest(
        application,
        `${target}/manage/boards/${f.boardB.id}`,
        { token: owner, method: "PATCH", body: { name: "updated" } },
      )).status,
      428,
    );
    const updated = await jsonRequest(
      application,
      `${target}/manage/boards/${f.boardB.id}`,
      {
        token: owner,
        method: "PATCH",
        body: { name: "updated" },
        headers: { "If-Match": "0" },
      },
    );
    assertEquals(updated.status, 200);
    assertEquals((await updated.json()).data.revision, 1);
    assertEquals(
      (await jsonRequest(
        application,
        `${target}/manage/boards/${f.boardB.id}`,
        {
          token: owner,
          method: "PATCH",
          body: { name: "stale" },
          headers: { "If-Match": "0" },
        },
      )).status,
      409,
    );
    await setMemberRoles(f.target.slug, f.b, f.student, ["member"]);
    assertEquals(
      (await jsonRequest(application, `${target}/manage/boards`, {
        token: student,
      })).status,
      403,
    );
    assertEquals(
      (await jsonRequest(application, `${target}/posts/${f.postB.id}`, {
        token: student,
        method: "DELETE",
      })).status,
      403,
    );
  },
});

Deno.test({
  name: "账号 SSE：持久重放只有定位字段，移除域成员后跳过旧通知但保留账号连接",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const f = await domainFixture("community-sse"), application = app();
    const student = await signToken({ sub: f.student, role: "user" });
    const comment = await withDomainCommunity(f.target.slug, f.student, {
      write: true,
      permission: "community:comment",
    }, (s) =>
      createComment(
        f.student,
        f.postB.id,
        "student comment",
        undefined,
        false,
        s,
      ));
    await withDomainCommunity(f.target.slug, f.b, {
      write: true,
      permission: "community:comment",
    }, (s) =>
      createComment(
        f.b,
        f.postB.id,
        "teacher private reply",
        comment.id,
        true,
        s,
      ));
    const actual = (await f.db.select().from(accountNotifications)).find(
      (n) => n.recipient_id === f.student,
    )!;
    const cursor = await recordSseEvent(Channels.user(f.student), {
      type: "notification:new",
      notification_id: actual.id,
      content: "never forward this",
      score: 9000,
    });
    const controller = new AbortController();
    const response = await application.request(
      `/api/v1/notifications/events`,
      {
        headers: {
          Authorization: `Bearer ${student}`,
          "Last-Event-ID": String(cursor - 1),
        },
        signal: controller.signal,
      },
    );
    assertEquals(response.status, 200);
    const reader = response.body!.getReader(), decoder = new TextDecoder();
    try {
      const replay = decoder.decode((await reader.read()).value);
      assert(replay.includes(actual.id));
      assert(replay.includes(`id: ${cursor}`));
      assert(!replay.includes("never forward"));
      assert(!replay.includes("9000"));
      const connected = decoder.decode((await reader.read()).value);
      assert(connected.includes("connected"));
      await removeDomainMember(f.target.slug, f.b, f.student);
      const follow = crypto.randomUUID();
      await f.db.insert(accountNotifications).values({
        id: follow,
        recipient_id: f.student,
        actor_id: f.b,
        type: "follow",
        created_at: new Date().toISOString(),
      });
      const next = reader.read();
      _dispatchToLocalListenersForTest(
        Channels.user(f.student),
        JSON.stringify({
          type: "notification:new",
          notification_id: actual.id,
        }),
      );
      _dispatchToLocalListenersForTest(
        Channels.user(f.student),
        JSON.stringify({ type: "notification:new", notification_id: follow }),
      );
      const live = decoder.decode((await next).value);
      assert(!live.includes(actual.id));
      assert(live.includes(follow));
    } finally {
      controller.abort();
      await reader.cancel();
    }
  },
});
