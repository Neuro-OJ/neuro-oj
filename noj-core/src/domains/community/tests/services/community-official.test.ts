import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import {
  communityPosts,
  evaluationResults,
  problems,
  submissions,
  users,
} from "../../../../shared/db/schema.ts";
import { nowIso } from "../../../../shared/base/dates.ts";
import {
  ForbiddenError,
  ValidationError,
} from "../../../../shared/base/errors.ts";
import { createPost, listPosts, setPostOfficial } from "../../index.ts";
import {
  _resetSystemSettingsForTest,
  ensureRbacSeeds,
  enterTestContext,
  initSystemSettings,
  leaveTestContext,
  updateSetting,
} from "../../../system/index.ts";

const ownerId = "official-owner";
const otherId = "official-other";
const problemId = "official-problem";

async function setup(): Promise<void> {
  await resetDbForTest();
  await ensureRbacSeeds();
  _resetSystemSettingsForTest();
  await initSystemSettings();
  const now = new Date().toISOString();
  await getDb().insert(users).values([
    {
      id: ownerId,
      username: ownerId,
      email: `${ownerId}@example.com`,
      password_hash: "hash",
      created_at: now,
      updated_at: now,
    },
    {
      id: otherId,
      username: otherId,
      email: `${otherId}@example.com`,
      password_hash: "hash",
      created_at: now,
      updated_at: now,
    },
  ]);
  await getDb().insert(problems).values({
    id: problemId,
    title: "官方题解测试题",
    description: "题面",
    difficulty: "easy",
    runtime_config: {},
    number: 960001,
    type: "U",
    visibility: "public",
    owner_id: ownerId,
    created_at: now,
    updated_at: now,
  });
  enterTestContext({ actorId: "0", actorIp: "127.0.0.1", actorRole: "admin" });
  try {
    await updateSetting("community_enabled", true, "0");
    await updateSetting("community_new_user_review_hours", 0, "0");
  } finally {
    leaveTestContext();
  }
}

Deno.test({
  name: "official: 题目 owner 可标记官方题解，非 owner 被拒",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    const post = await createPost(otherId, {
      type: "solution",
      title: "民间题解",
      content: "思路",
      problem_id: problemId,
    }, true);

    // 非题目 owner 且非审核员 → 拒绝（服务层强制，不依赖前端隐藏）
    await assertRejects(
      () => setPostOfficial(post.id, otherId, false, true),
      ForbiddenError,
    );

    // 题目 owner 可标记
    await setPostOfficial(post.id, ownerId, false, true);
    const [row] = await getDb()
      .select({ is_official: communityPosts.is_official })
      .from(communityPosts)
      .where(eq(communityPosts.id, post.id));
    assertEquals(row?.is_official, true);

    // 可取消
    await setPostOfficial(post.id, ownerId, false, false);
    const [row2] = await getDb()
      .select({ is_official: communityPosts.is_official })
      .from(communityPosts)
      .where(eq(communityPosts.id, post.id));
    assertEquals(row2?.is_official, false);
  },
});

Deno.test({
  name: "official: 官方标记仅适用于题解类型",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    const moment = await createPost(otherId, {
      type: "moment",
      content: "一条动态",
    }, true);
    await assertRejects(
      () => setPostOfficial(moment.id, ownerId, false, true),
      ValidationError,
    );
  },
});

Deno.test({
  name: "official: 官方题解在列表中排在前面",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    // 先发非官方（时间更早），再发官方（时间更晚）
    const older = await createPost(otherId, {
      type: "solution",
      title: "较早的非官方题解",
      content: "A",
      problem_id: problemId,
    }, true);
    const newer = await createPost(otherId, {
      type: "solution",
      title: "较晚的官方题解",
      content: "B",
      problem_id: problemId,
    }, true);
    await setPostOfficial(newer.id, ownerId, false, true);

    const list = await listPosts({ type: "solution", problemId });
    // 官方优先，即使发布时间更晚
    assertEquals(list.data[0]?.post.id, newer.id);
    assertEquals(list.data[1]?.post.id, older.id);
  },
});

Deno.test({
  name: "official: 创建时声明官方——owner 被信任，普通用户被忽略",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();

    // 发布门槛（solution_requires_accepted 默认 true）对 owner 同样生效，
    // 因此给两个用户各造一条 AC 提交，双方都能走 moderator=false 的真实路径。
    for (const userId of [ownerId, otherId]) {
      const submissionId = crypto.randomUUID();
      await getDb().insert(submissions).values({
        id: submissionId,
        user_id: userId,
        problem_id: problemId,
        language: "python3",
        code: "print(1)",
        status: "finished",
        created_at: nowIso(),
      });
      await getDb().insert(evaluationResults).values({
        id: crypto.randomUUID(),
        submission_id: submissionId,
        status: "finished",
        score: 10000,
        output: "",
        details: "{}",
        created_at: nowIso(),
      });
    }

    // 题目 owner 的官方声明被信任
    const byOwner = await createPost(ownerId, {
      type: "solution",
      title: "owner 发布并声明官方",
      content: "C",
      problem_id: problemId,
      is_official: true,
    }, false);
    assertEquals(byOwner.is_official, true);

    // 非 owner 的官方声明不被信任（否则任何人都能把题解标成官方）
    const byOther = await createPost(otherId, {
      type: "solution",
      title: "普通用户自称官方",
      content: "D",
      problem_id: problemId,
      is_official: true,
    }, false);
    assertEquals(byOther.is_official, false);
  },
});

/**
 * 2026-09-14 评审回归：`createPost` 曾只校验 `isProblemOwner` 而不限定帖子类型。
 *
 * `discussion` / `moment` 不会规范化 `problem_id`（只有 `solution` 会），因此客户端
 * 夹带任意**公开题**的 id 就能让 `isProblemOwner` 为真；又因 `listPosts` 无条件按
 * `is_official` 置顶排序，这类帖子会置顶社区列表，绕过 `setPostOfficial` 的
 * "仅题解可标记"规则。
 */
/**
 * 2026-09-14 评审回归：`createPost` 曾只校验 `isProblemOwner` 而不限定帖子类型。
 *
 * `discussion` / `moment` 不会规范化 `problem_id`（只有 `solution` 会），因此客户端
 * 夹带任意**公开题**的 id 就能让 `isProblemOwner` 为真；又因 `listPosts` 无条件按
 * `is_official` 置顶排序，这类帖子会置顶社区列表，绕过 `setPostOfficial` 的
 * "仅题解可标记"规则。
 */
Deno.test({
  name: "official: 非题解夹带 problem_id 不能获得官方标记（防置顶绕过）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    // owner 发 moment，夹带自己拥有的公开题 id 并自称官方。
    // moment 不校验 problem_id，故客户端可任意夹带——正是攻击面所在。
    const moment = await createPost(ownerId, {
      type: "moment",
      content: "动态夹带题目 id",
      problem_id: problemId,
      is_official: true,
    }, false);
    assertEquals(moment.is_official, false);
    // 非题解不得持久化题目关联（否则会被当作"某题的官方内容"参与置顶）
    assertEquals(moment.problem_id, null);

    // 即便审核员发 moment 也不应被标记：该标记只属于题解这一语义
    const moderatorMoment = await createPost(ownerId, {
      type: "moment",
      content: "审核员的动态",
      problem_id: problemId,
      is_official: true,
    }, true);
    assertEquals(moderatorMoment.is_official, false);

    // 确认这类帖子不会因 is_official 排到列表最前（排序键 is_official 优先）
    const listed = await listPosts({ type: "moment" });
    assertEquals(listed.data.length > 0, true);
    assertEquals(
      listed.data.every((row) => row.post.is_official === false),
      true,
    );

    // 对照见上一条用例「创建时声明官方——owner 被信任，普通用户被忽略」：
    // 那里已用满足通过门槛的夹具验证题解路径未被误伤。
  },
});
