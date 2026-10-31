import { assertEquals, assertIsError, assertRejects } from "jsr:@std/assert@^1";
import { sql } from "drizzle-orm";
import { getDb } from "../../src/shared/db/connection.ts";
import { resetDbForTest } from "../helpers/db.ts";
import {
  accountNotifications as communityNotifications,
  communityBoards,
  communityComments,
  communityPosts,
  communityReports,
  problems,
} from "../../src/shared/db/schema.ts";
import { createDomain } from "../../src/modules/access/workspace/index.ts";
import { DEFAULT_DOMAIN_ID } from "../../src/shared/workspace/types.ts";
import { problemExecutionForTest } from "../helper.ts";

async function fixture() {
  await resetDbForTest();
  const db = getDb(), now = new Date().toISOString();
  const other = await createDomain(
    { slug: "community-integrity", name: "另一域", preset: "community" },
    "0",
    { approved: true },
  );
  const boardId = crypto.randomUUID(),
    postId = crypto.randomUUID(),
    problemId = crypto.randomUUID();
  await db.insert(problems).values({
    id: problemId,
    domain_id: DEFAULT_DOMAIN_ID,
    number: 998039,
    title: "原题",
    description: "约束夹具",
    owner_id: "0",
    created_at: now,
    updated_at: now,
  });
  await db.insert(communityBoards).values({
    id: boardId,
    domain_id: DEFAULT_DOMAIN_ID,
    slug: "integrity",
    name: "讨论",
    created_at: now,
    updated_at: now,
  });
  await db.insert(communityPosts).values({
    id: postId,
    domain_id: DEFAULT_DOMAIN_ID,
    type: "discussion",
    author_id: "0",
    board_id: boardId,
    title: "原帖",
    content: "保留内容",
    created_at: now,
    updated_at: now,
  });
  return { db, now, other, boardId, postId, problemId };
}

async function rejectsWithCode(write: () => Promise<unknown>, code: string) {
  const error = await assertRejects(write);
  assertIsError(error);
  assertEquals((error.cause as { code: string }).code, code);
}

Deno.test("社区约束：内容必须有域，题解必须有真实题库绑定", async () => {
  const f = await fixture();
  await rejectsWithCode(
    () =>
      f.db.transaction((tx) =>
        tx.execute(sql`INSERT INTO community_boards
        (id, slug, name, created_at, updated_at)
        VALUES (${crypto.randomUUID()}, 'missing-domain', '无归属', ${f.now}, ${f.now})`)
      ),
    "23502",
  );
  await rejectsWithCode(
    () =>
      f.db.transaction((tx) =>
        tx.execute(
          sql`UPDATE community_posts SET type = 'solution', board_id = NULL,
        problem_id = ${f.problemId} WHERE id = ${f.postId}`,
        )
      ),
    "23514",
  );
});

Deno.test("社区约束：评论、举报、通知不能挂入另一个域的真实帖子", async () => {
  const f = await fixture();
  const writes = [
    () =>
      f.db.transaction((tx) =>
        tx.insert(communityComments).values({
          id: crypto.randomUUID(),
          domain_id: f.other.id,
          post_id: f.postId,
          author_id: "0",
          content: "错误域评论",
          created_at: f.now,
          updated_at: f.now,
        })
      ),
    () =>
      f.db.transaction((tx) =>
        tx.insert(communityReports).values({
          id: crypto.randomUUID(),
          domain_id: f.other.id,
          post_id: f.postId,
          reporter_id: "0",
          content_type: "post",
          reason: "错误域举报",
          content_snapshot: "原帖",
          created_at: f.now,
          updated_at: f.now,
        })
      ),
    () =>
      f.db.transaction((tx) =>
        tx.insert(communityNotifications).values({
          id: crypto.randomUUID(),
          domain_id: f.other.id,
          post_id: f.postId,
          recipient_id: "0",
          type: "like",
          created_at: f.now,
        })
      ),
  ];
  for (const write of writes) await rejectsWithCode(write, "23503");
});

Deno.test("社区约束：关注和封禁属于账号，内容通知删除目标后仍保留域", async () => {
  const f = await fixture();
  await f.db.insert(communityNotifications).values([
    {
      id: crypto.randomUUID(),
      recipient_id: "0",
      type: "follow",
      created_at: f.now,
    },
    {
      id: crypto.randomUUID(),
      recipient_id: "0",
      type: "ban",
      created_at: f.now,
    },
    // 软删除清除目标后的历史通知仍须保留原域。
    {
      id: crypto.randomUUID(),
      domain_id: DEFAULT_DOMAIN_ID,
      recipient_id: "0",
      type: "reply",
      created_at: f.now,
    },
  ]);
  for (
    const value of [
      { type: "follow", domain_id: DEFAULT_DOMAIN_ID },
      { type: "like", domain_id: null },
    ]
  ) {
    await rejectsWithCode(
      () =>
        f.db.transaction((tx) =>
          tx.insert(communityNotifications).values({
            id: crypto.randomUUID(),
            recipient_id: "0",
            created_at: f.now,
            ...value,
          })
        ),
      "23514",
    );
  }
  const rows = await f.db.select().from(communityNotifications);
  assertEquals(rows.find((row) => row.type === "follow")?.domain_id, null);
  assertEquals(
    rows.find((row) => row.type === "reply")?.domain_id,
    DEFAULT_DOMAIN_ID,
  );
});

Deno.test("社区迁移：真实父关系回填域，原正文和账号通知保留", async () => {
  const f = await fixture();
  const execution = await problemExecutionForTest(f.problemId);
  // 在回滚隔离中恢复迁移前的空归属，执行当前迁移的实际回填与约束。
  for (
    const table of [
      "community_boards",
      "community_posts",
      "community_comments",
      "community_sanctions",
    ]
  ) {
    await f.db.execute(
      sql.raw(`ALTER TABLE ${table} ALTER COLUMN domain_id DROP NOT NULL`),
    );
  }
  for (
    const [table, constraints] of [
      ["community_posts", ["community_posts_binding_required_check"]],
      ["community_reports", [
        "community_reports_workspace_check",
        "community_reports_workspace_post_fk",
        "community_reports_workspace_comment_fk",
      ]],
      ["notifications", [
        "community_notifications_workspace_check",
        "community_notifications_workspace_post_fk",
        "community_notifications_workspace_comment_fk",
      ]],
      ["community_moderation_actions", [
        "community_moderation_actions_workspace_check",
      ]],
    ] as const
  ) {
    for (const constraint of constraints) {
      await f.db.execute(
        sql.raw(`ALTER TABLE ${table} DROP CONSTRAINT ${constraint}`),
      );
    }
  }
  await f.db.execute(
    sql.raw(
      "CREATE UNIQUE INDEX community_boards_legacy_slug_unique ON community_boards(slug) WHERE domain_id IS NULL",
    ),
  );
  await f.db.execute(
    sql`UPDATE community_posts SET domain_id = NULL WHERE id = ${f.postId}`,
  );
  await f.db.execute(
    sql`UPDATE community_boards SET domain_id = NULL WHERE id = ${f.boardId}`,
  );
  const solutionId = crypto.randomUUID(),
    commentId = crypto.randomUUID(),
    reportId = crypto.randomUUID();
  await f.db.execute(sql`INSERT INTO community_posts
    (id, type, author_id, problem_id, title, content, created_at, updated_at)
    VALUES (${solutionId}, 'solution', '0', ${f.problemId}, '旧题解', '原题解字节', ${f.now}, ${f.now})`);
  await f.db.execute(sql`INSERT INTO community_comments
    (id, post_id, author_id, content, created_at, updated_at)
    VALUES (${commentId}, ${f.postId}, '0', '原评论字节', ${f.now}, ${f.now})`);
  await f.db.execute(sql`INSERT INTO community_reports
    (id, reporter_id, comment_id, content_type, reason, content_snapshot, created_at, updated_at)
    VALUES (${reportId}, '0', ${commentId}, 'comment', '原举报理由', '原评论字节', ${f.now}, ${f.now})`);
  await f.db.execute(sql`INSERT INTO community_moderation_actions
    (id, action, target_type, target_id, created_at)
    VALUES (${crypto.randomUUID()}, 'hidden', 'comment', ${commentId}, ${f.now})`);
  await f.db.insert(communityNotifications).values([
    {
      id: crypto.randomUUID(),
      recipient_id: "0",
      type: "report",
      data: { report_id: reportId },
      created_at: f.now,
    },
    {
      id: crypto.randomUUID(),
      recipient_id: "0",
      type: "follow",
      created_at: f.now,
    },
    {
      id: crypto.randomUUID(),
      recipient_id: "0",
      type: "ban",
      created_at: f.now,
    },
  ]);
  const migration = await Deno.readTextFile(
    new URL("../../drizzle/0116_peaceful_gorilla_man.sql", import.meta.url),
  );
  const backfill = migration.split("-- BEGIN COMMUNITY WORKSPACE BACKFILL")[1]
    .split("-- END COMMUNITY WORKSPACE BACKFILL")[0]
    .replaceAll("community_notifications", "notifications");
  const restoredConstraints = new Set([
    "community_posts_binding_required_check",
    "community_reports_workspace_check",
    "community_reports_workspace_post_fk",
    "community_reports_workspace_comment_fk",
    "community_notifications_workspace_check",
    "community_notifications_workspace_post_fk",
    "community_notifications_workspace_comment_fk",
    "community_moderation_actions_workspace_check",
  ]);
  const contraction = migration.split("--> statement-breakpoint").filter((
    statement,
  ) =>
    /ALTER TABLE "(community_boards|community_posts|community_comments|community_sanctions)" ALTER COLUMN "domain_id" SET NOT NULL/
      .test(statement) ||
    [...restoredConstraints].some((name) =>
      statement.includes(`ADD CONSTRAINT "${name}"`)
    )
  ).map((statement) =>
    statement.replaceAll(
      'ALTER TABLE "community_notifications"',
      'ALTER TABLE "notifications"',
    ).replaceAll(
      '"community_notifications"."',
      '"notifications"."',
    )
  );
  for (
    const statement of [
      ...backfill.split("--> statement-breakpoint"),
      ...contraction,
    ]
  ) {
    if (statement.trim()) await f.db.execute(sql.raw(statement));
  }
  const posts = await f.db.select().from(communityPosts);
  assertEquals(
    posts.find((post) => post.id === f.postId)?.domain_id,
    DEFAULT_DOMAIN_ID,
  );
  const solution = posts.find((post) => post.id === solutionId)!;
  assertEquals([
    solution.domain_id,
    solution.domain_problem_binding_id,
    solution.content,
  ], [DEFAULT_DOMAIN_ID, execution.domain_problem_binding_id, "原题解字节"]);
  const [comment] = await f.db.select().from(communityComments);
  assertEquals([comment.domain_id, comment.content], [
    DEFAULT_DOMAIN_ID,
    "原评论字节",
  ]);
  const [report] = await f.db.select().from(communityReports);
  assertEquals([report.domain_id, report.reason], [
    DEFAULT_DOMAIN_ID,
    "原举报理由",
  ]);
  const notifications = await f.db.select().from(communityNotifications);
  for (const notification of notifications) {
    assertEquals(
      notification.domain_id,
      notification.type === "report" ? DEFAULT_DOMAIN_ID : null,
    );
  }
});
