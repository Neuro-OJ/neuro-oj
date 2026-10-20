import {
  deleteProblemFixtures,
  problemExecutionForTest,
  publishBaselineVersionForTest,
} from "../../../../../tests/helper.ts";
import { DEFAULT_DOMAIN_ID } from "../../../../shared/workspace/types.ts";
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { getUserProfileAggregate, updateUserProfile } from "../../index.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import { resetDbForTest } from "../../../../../tests/helpers/db.ts";
import {
  evaluationAttempts,
  problems,
  submissions,
  users,
} from "../../../../shared/db/schema.ts";
import {
  NotFoundError,
  ValidationError,
} from "../../../../shared/base/errors.ts";
import { eq } from "drizzle-orm";

const ts = Date.now();
const TEST_USER_ID = `tst-u-${ts}`;

// 模块级 setup：事务外初始化共享测试用户
await resetDbForTest();
const db = getDb();
const now = new Date().toISOString();
await db.insert(users).values({
  id: TEST_USER_ID,
  username: `tstusr-${ts}`,
  email: `tstusr-${ts}@test.noj`,
  password_hash: "hash",
  bio: "",
  created_at: now,
  updated_at: now,
});

Deno.test({
  name: "users service: getUserProfileAggregate 返回完整用户主页数据",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const profile = await getUserProfileAggregate(TEST_USER_ID);
    assertEquals(profile.user.id, TEST_USER_ID);
    assertEquals(profile.user.username, `tstusr-${ts}`);
    assertEquals(typeof profile.stats.total_submissions, "number");
    assertEquals(typeof profile.stats.accepted, "number");
    assertEquals(typeof profile.stats.acceptance_rate, "number");
    assertEquals(typeof profile.stats.solved_count, "number");
    assertEquals(Array.isArray(profile.solved_problems), true);
    assertEquals(Array.isArray(profile.recent_submissions), true);
  },
});

Deno.test({
  name: "users service: getUserProfileAggregate 不存在的用户抛出 NotFoundError",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await assertRejects(
      () => getUserProfileAggregate("nonexistent-user"),
      NotFoundError,
      "用户不存在",
    );
  },
});

Deno.test({
  name: "users service: updateUserProfile 更新 bio 成功",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const bio = "updated bio " + ts;
    const result = await updateUserProfile(TEST_USER_ID, bio);
    assertEquals(result.id, TEST_USER_ID);
    assertEquals(result.bio, bio);
  },
});

Deno.test({
  name: "users service: updateUserProfile bio 超长抛出 ValidationError",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const longBio = "x".repeat(5001);
    await assertRejects(
      () => updateUserProfile(TEST_USER_ID, longBio),
      ValidationError,
    );
  },
});

Deno.test({
  name: "users service: updateUserProfile 不存在的用户抛出 NotFoundError",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await assertRejects(
      () => updateUserProfile("nonexistent-user", "bio"),
      NotFoundError,
      "用户不存在",
    );
  },
});

Deno.test({
  name: "users service: 清理测试数据",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    await db.delete(users).where(eq(users.id, TEST_USER_ID));
  },
});

Deno.test({
  name: "users service: 最近提交读最近终态尝试（含存量回退）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // 该用例排在“清理测试数据”之后也必须独立成立；不要复用已被清理的模块用户。
    const recentUserId = `tst-recent-user-${ts}`;
    await db.insert(users).values({
      id: recentUserId,
      username: `tstrecent-${ts}`,
      email: `tstrecent-${ts}@test.noj`,
      password_hash: "hash",
      created_at: now,
      updated_at: now,
    });
    const problemId = `tst-recent-prob-${ts}`;
    await db.insert(problems).values({
      domain_id: DEFAULT_DOMAIN_ID,
      id: problemId,
      title: "最近提交题",
      description: "d",
      number: 95000 + (ts % 1000),
      owner_id: "0",
      difficulty: "easy",
      created_at: now,
      updated_at: now,
    });
    // 先插提交（尝试对提交有外键），再插尝试，最后回填指针
    await publishBaselineVersionForTest(problemId);
    await db.insert(submissions).values([
      {
        id: `tst-recent-s1-${ts}`,
        user_id: recentUserId,
        problem_id: problemId,
        ...await problemExecutionForTest(problemId),
        language: "python3",
        code: "print(1)",
        version_origin: "legacy_unknown",
        is_valid: true,
        created_at: now,
      },
      {
        id: `tst-recent-s2-${ts}`,
        user_id: recentUserId,
        problem_id: problemId,
        ...await problemExecutionForTest(problemId),
        language: "python3",
        code: "print(2)",
        version_origin: "legacy_unknown",
        is_valid: true,
        is_accepted: true,
        created_at: now,
      },
    ]);
    await db.insert(evaluationAttempts).values([
      {
        // 已知最新尝试：result_status/score 取该尝试
        id: `tst-recent-a1-${ts}`,
        submission_id: `tst-recent-s1-${ts}`,
        problem_id: problemId,
        sequence: 1,
        source: "rejudge",
        state: "finished",
        result_kind: "graded",
        result_status: "finished",
        score: 7000,
        accepted: false,
        created_at: now,
      },
      {
        // 存量行：只有有效成绩指针，没有 latest_attempt_id
        id: `tst-recent-a2-${ts}`,
        submission_id: `tst-recent-s2-${ts}`,
        problem_id: problemId,
        sequence: 0,
        source: "legacy_import",
        state: "finished",
        result_kind: "graded",
        result_status: "finished",
        score: 10000,
        accepted: true,
        created_at: now,
      },
    ]);
    await db.update(submissions).set({
      latest_attempt_id: `tst-recent-a1-${ts}`,
      effective_attempt_id: `tst-recent-a1-${ts}`,
    }).where(eq(submissions.id, `tst-recent-s1-${ts}`));
    await db.update(submissions).set({
      effective_attempt_id: `tst-recent-a2-${ts}`,
    }).where(eq(submissions.id, `tst-recent-s2-${ts}`));

    const profile = await getUserProfileAggregate(recentUserId, false, {
      viewerId: recentUserId,
    });
    const byId = new Map(
      profile.recent_submissions.map((row) => [row.id, row]),
    );
    // 响应里的 score 已由 scoreFromDb 还原为百分制（7000 ×100 存储 → 70）
    assertEquals(byId.get(`tst-recent-s1-${ts}`)?.score, 70);
    assertEquals(byId.get(`tst-recent-s1-${ts}`)?.result_status, "finished");
    // 存量行回退到有效成绩指针
    assertEquals(byId.get(`tst-recent-s2-${ts}`)?.score, 100);

    await db.delete(submissions).where(
      eq(submissions.problem_id, problemId),
    );
    await db.delete(evaluationAttempts).where(
      eq(evaluationAttempts.problem_id, problemId),
    );
    await deleteProblemFixtures(eq(problems.id, problemId));
    await db.delete(users).where(eq(users.id, recentUserId));
  },
});
