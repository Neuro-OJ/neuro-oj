/**
 * 赛时社区全局静默（决策 1 · 方案 A · N-01）回归。
 *
 * 此前静默只覆盖 `createPost` 的讨论/动态，而以下三条写路径不受限：
 * - `createComment`：在任意可见帖下评论，向全场广播完整解法；
 * - `updateComment`：把赛前评论改写为解法；
 * - `updatePost`：把赛前发布的讨论/动态/题解改写为解法；
 * - `createPost(type=solution)`：给非赛题发题解，正文夹带赛题解法
 *   （按挂靠题目判定的保密门控无法识别）。
 * 本文件锁定：公开赛未结束（含 pending）时普通用户上述写入一律 CONTEST_SILENCE，
 * 审核员免静默，赛后自动恢复。
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import {
  communityComments,
  communityPosts,
  contests,
  problems,
  users,
} from "../../../../shared/db/schema.ts";
import {
  createComment,
  createPost,
  updateComment,
  updatePost,
} from "../../index.ts";
import { createContest } from "../../../contest/index.ts";
import { ForbiddenError } from "../../../../shared/base/errors.ts";
import {
  _resetSystemSettingsForTest,
  ensureRbacSeeds,
  enterTestContext,
  initSystemSettings,
  leaveTestContext,
  updateSetting,
} from "../../../system/index.ts";

const ownerId = "silence-owner";
const userId = "silence-user";
const normalProblemId = "silence-normal-problem";
const contestProblemId = "silence-contest-problem";
let contestId = "";
let momentId = "";
let solutionId = "";
let commentId = "";

async function setup(): Promise<void> {
  await resetDbForTest();
  await ensureRbacSeeds();
  _resetSystemSettingsForTest();
  await initSystemSettings();
  const now = new Date().toISOString();
  await getDb().insert(users).values([ownerId, userId].map((id) => ({
    id,
    username: id,
    email: `${id}@example.com`,
    password_hash: "hash",
    created_at: now,
    updated_at: now,
  })));
  await getDb().insert(problems).values(
    [normalProblemId, contestProblemId].map((id, i) => ({
      id,
      title: id,
      description: "x",
      difficulty: "easy",
      runtime_config: {},
      number: 971001 + i,
      type: "U",
      visibility: "public",
      owner_id: ownerId,
      created_at: now,
      updated_at: now,
    })),
  );
  enterTestContext({ actorId: "0", actorIp: "127.0.0.1", actorRole: "admin" });
  try {
    await updateSetting("community_enabled", true, "0");
    await updateSetting("community_new_user_review_hours", 0, "0");
  } finally {
    leaveTestContext();
  }

  // 赛前已存在的内容：一条动态、一条普通题题解、动态下一条评论
  momentId = crypto.randomUUID();
  solutionId = crypto.randomUUID();
  commentId = crypto.randomUUID();
  await getDb().insert(communityPosts).values([
    {
      id: momentId,
      type: "moment",
      author_id: userId,
      content: "赛前动态",
      created_at: now,
      updated_at: now,
    },
    {
      id: solutionId,
      type: "solution",
      author_id: userId,
      problem_id: normalProblemId,
      title: "普通题题解",
      content: "赛前题解",
      created_at: now,
      updated_at: now,
    },
  ]);
  await getDb().insert(communityComments).values({
    id: commentId,
    post_id: momentId,
    author_id: userId,
    parent_id: null,
    content: "赛前评论",
    status: "published",
    moderation_reason: null,
    created_at: now,
    updated_at: now,
  });

  // 进行中的公开赛（管理员创建默认 kind=public）
  const contest = await createContest(
    {
      title: `静默测试 ${Date.now()}`,
      start_time: new Date(Date.now() - 60_000).toISOString(),
      end_time: new Date(Date.now() + 3_600_000).toISOString(),
      type: "kaggle",
      problems: [{
        problem_id: contestProblemId,
        label: "A",
        sort_order: 0,
        score: 10000,
      }],
    },
    ownerId,
    true,
  );
  contestId = contest.id;
}

async function endContest(): Promise<void> {
  await getDb().update(contests).set({
    start_time: new Date(Date.now() - 7_200_000).toISOString(),
    end_time: new Date(Date.now() - 1_000).toISOString(),
  }).where(eq(contests.id, contestId));
}

Deno.test({
  name: "contest-silence: 赛中普通用户不能发表评论，赛后恢复",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    await assertRejects(
      () => createComment(userId, momentId, "完整解法"),
      ForbiddenError,
      "比赛期间",
    );
    // 题解帖下同样不能评论（普通题题解也是全场可见的广播面）
    await assertRejects(
      () => createComment(userId, solutionId, "完整解法"),
      ForbiddenError,
      "比赛期间",
    );
    // 审核员免静默
    const official = await createComment(
      ownerId,
      momentId,
      "官方说明",
      undefined,
      true,
    );
    assertEquals(official.content, "官方说明");

    await endContest();
    const after = await createComment(userId, momentId, "赛后讨论");
    assertEquals(after.content, "赛后讨论");
  },
});

Deno.test({
  name: "contest-silence: 赛前筹备期（pending）同样静默评论",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    await getDb().update(contests).set({
      start_time: new Date(Date.now() + 3_600_000).toISOString(),
      end_time: new Date(Date.now() + 7_200_000).toISOString(),
    }).where(eq(contests.id, contestId));
    await assertRejects(
      () => createComment(userId, momentId, "赛前泄题"),
      ForbiddenError,
      "比赛期间",
    );
  },
});

Deno.test({
  name: "contest-silence: 赛中不能把旧评论改写为解法",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    await assertRejects(
      () => updateComment(commentId, userId, false, "改写后的完整解法"),
      ForbiddenError,
      "比赛期间",
    );
    const [row] = await getDb().select().from(communityComments).where(
      eq(communityComments.id, commentId),
    );
    assertEquals(row!.content, "赛前评论");

    await endContest();
    const after = await updateComment(commentId, userId, false, "赛后修改");
    assertEquals(after.content, "赛后修改");
  },
});

Deno.test({
  name: "contest-silence: 赛中不能把旧动态或旧题解改写为解法",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    await assertRejects(
      () =>
        updatePost(momentId, userId, false, { content: "改写后的完整解法" }),
      ForbiddenError,
      "比赛期间",
    );
    const [row] = await getDb().select().from(communityPosts).where(
      eq(communityPosts.id, momentId),
    );
    assertEquals(row!.content, "赛前动态");

    // 审核员可编辑
    const byModerator = await updatePost(momentId, ownerId, true, {
      content: "审核员修订",
    });
    assertEquals(byModerator.content, "审核员修订");

    // 普通题的旧题解同样不能在赛中改写
    await assertRejects(
      () =>
        updatePost(solutionId, userId, false, { content: "改写后的完整解法" }),
      ForbiddenError,
      "比赛期间",
    );

    await endContest();
    const after = await updatePost(momentId, userId, false, {
      content: "赛后修改",
    });
    assertEquals(after.content, "赛后修改");
  },
});

Deno.test({
  name: "contest-silence: 赛中不能给非赛题发题解，赛题仍报 CONTEST_SECRECY",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    // 关掉"需先通过本题"门槛，确保拦截原因是静默而非 AC 门槛
    enterTestContext({
      actorId: "0",
      actorIp: "127.0.0.1",
      actorRole: "admin",
    });
    try {
      await updateSetting("community_solution_requires_accepted", false, "0");
    } finally {
      leaveTestContext();
    }
    const input = {
      type: "solution" as const,
      title: "普通题题解",
      content: "正文夹带赛题解法",
      problem_id: normalProblemId,
    };
    await assertRejects(
      () => createPost(userId, input),
      ForbiddenError,
      "比赛期间",
    );
    // 赛题本身仍得到更具体的保密提示
    await assertRejects(
      () => createPost(userId, { ...input, problem_id: contestProblemId }),
      ForbiddenError,
      "该题目当前归属于公开赛",
    );
    // 审核员免静默
    const official = await createPost(ownerId, input, true);
    assertEquals(official.type, "solution");

    await endContest();
    const after = await createPost(userId, input);
    assertEquals(after.type, "solution");
  },
});
