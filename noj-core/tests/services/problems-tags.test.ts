/**
 * 题目标签关联与算法标签可视性门控的单测（issue #223）。
 *
 * 覆盖：
 * - syncProblemTags：不存在标签 400 / 客观题+算法 400 / 全量替换 / 重复 id 去重
 * - applyAlgorithmTagVisibility 门控四态：匿名 / 未通过 / 已通过 / admin / 题主 /
 *   无算法标签
 *
 * 注：applyAlgorithmTagVisibility 内部经 hasPassedSubmission 读
 * evaluation_results，直接以真实 DB 行驱动（非 mock）。
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq, inArray } from "drizzle-orm";
import { initRedisForTest } from "../helper.ts";
import { getDb } from "./../../src/shared/db/connection.ts";
import {
  evaluationResults,
  problems,
  problemTags,
  submissions,
  tags,
  users,
} from "./../../src/shared/db/schema.ts";
import { BadRequestError } from "./../../src/shared/base/errors.ts";
import { syncProblemTags } from "../../src/domains/catalog/index.ts";
import {
  applyAlgorithmTagVisibility,
  getProblem,
} from "../../src/domains/catalog/index.ts";
import { createTag } from "../../src/domains/catalog/index.ts";

const hasEnv = !!Deno.env.get("JWT_SECRET");
const skip = !hasEnv;

import { resetDbForTest } from "./../../src/shared/db/connection.ts";
await resetDbForTest();
await initRedisForTest();

const ts = Date.now();

/** 建一道 P 型编程题（runtime_config 可空，服务层不校验 DB 层）。 */
async function createTestProblem(): Promise<string> {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(problems).values({
    id,
    title: `门控测试题-${ts}-${Math.random().toString(36).slice(2, 6)}`,
    description: "描述",
    difficulty: "easy",
    runtime_config: null,
    is_objective: false,
    number: 940000 + (ts % 10000),
    owner_id: "0",
    type: "P",
    created_at: now,
    updated_at: now,
  });
  return id;
}

/** 建一个用户（无 RBAC 角色关联也可——门控只读 users 行）。 */
async function createTestUser(): Promise<string> {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(users).values({
    id,
    username: `gate_user_${ts}_${Math.random().toString(36).slice(2, 6)}`,
    email: `${id}@test.local`,
    password_hash: "x",
    must_change_password: false,
    created_at: now,
    updated_at: now,
  });
  return id;
}

Deno.test({
  name: "problems-tags: 关联不存在的标签返回 400",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const problemId = await createTestProblem();
    await assertRejects(
      () => syncProblemTags(problemId, ["nonexistent-tag-id"]),
      BadRequestError,
    );
    const db = getDb();
    await db.delete(problems).where(eq(problems.id, problemId));
  },
});

Deno.test({
  name: "problems-tags: 客观题关联算法标签返回 400",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const algoTag = await createTag({
      name: `门控算法-${ts}`,
      kind: "algorithm",
    });
    const problemId = await createTestProblem();

    await assertRejects(
      () => syncProblemTags(problemId, [algoTag.id], true),
      BadRequestError,
      "客观题不能关联算法标签",
    );

    // 客观题 + 题目标签允许
    const probTag = await createTag({
      name: `门控主题-${ts}`,
      kind: "problem",
    });
    await syncProblemTags(problemId, [probTag.id], true);

    const db = getDb();
    const rows = await db
      .select()
      .from(problemTags)
      .where(eq(problemTags.problem_id, problemId));
    assertEquals(rows.length, 1);
    assertEquals(rows[0].tag_id, probTag.id);

    await db.delete(problemTags).where(eq(problemTags.problem_id, problemId));
    await db.delete(problems).where(eq(problems.id, problemId));
    await db.delete(tags).where(
      inArray(tags.id, [algoTag.id, probTag.id]),
    );
  },
});

Deno.test({
  name: "problems-tags: 全量替换语义与重复 id 去重",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const tagA = await createTag({ name: `替换A-${ts}`, kind: "problem" });
    const tagB = await createTag({ name: `替换B-${ts}`, kind: "problem" });
    const problemId = await createTestProblem();

    await syncProblemTags(problemId, [tagA.id]);
    await syncProblemTags(problemId, [tagB.id, tagB.id]); // 重复 id 应去重

    const db = getDb();
    const rows = await db
      .select()
      .from(problemTags)
      .where(eq(problemTags.problem_id, problemId));
    assertEquals(rows.length, 1);
    assertEquals(rows[0].tag_id, tagB.id);

    await db.delete(problemTags).where(eq(problemTags.problem_id, problemId));
    await db.delete(problems).where(eq(problems.id, problemId));
    await db.delete(tags).where(inArray(tags.id, [tagA.id, tagB.id]));
  },
});

Deno.test({
  name: "problems-tags: 门控——匿名用户不可见算法标签",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const algoTag = await createTag({ name: `门控A-${ts}`, kind: "algorithm" });
    const probTag = await createTag({ name: `门控P-${ts}`, kind: "problem" });
    const problemId = await createTestProblem();
    await syncProblemTags(problemId, [algoTag.id, probTag.id]);

    const problem = await getProblem(problemId);
    const visible = await applyAlgorithmTagVisibility(problem, {});

    assertEquals(visible.has_hidden_algorithm_tags, true);
    assertEquals(
      visible.tags.some((t) => t.kind === "algorithm"),
      false,
    );
    assertEquals(visible.tags.some((t) => t.kind === "problem"), true);

    const db = getDb();
    await db.delete(problemTags).where(eq(problemTags.problem_id, problemId));
    await db.delete(problems).where(eq(problems.id, problemId));
    await db.delete(tags).where(inArray(tags.id, [algoTag.id, probTag.id]));
  },
});

Deno.test({
  name: "problems-tags: 门控——无通过提交的登录用户不可见",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const algoTag = await createTag({
      name: `门控A2-${ts}`,
      kind: "algorithm",
    });
    const problemId = await createTestProblem();
    const userId = await createTestUser();
    await syncProblemTags(problemId, [algoTag.id]);

    const problem = await getProblem(problemId);
    const visible = await applyAlgorithmTagVisibility(problem, { userId });

    assertEquals(visible.has_hidden_algorithm_tags, true);
    assertEquals(visible.tags.some((t) => t.kind === "algorithm"), false);

    const db = getDb();
    await db.delete(problemTags).where(eq(problemTags.problem_id, problemId));
    await db.delete(problems).where(eq(problems.id, problemId));
    await db.delete(tags).where(eq(tags.id, algoTag.id));
    await db.delete(users).where(eq(users.id, userId));
  },
});

Deno.test({
  name: "problems-tags: 门控——有通过提交的用户可见",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const algoTag = await createTag({
      name: `门控A3-${ts}`,
      kind: "algorithm",
    });
    const problemId = await createTestProblem();
    const userId = await createTestUser();
    await syncProblemTags(problemId, [algoTag.id]);

    // 造一条通过提交（finished 且 score>0）
    const db = getDb();
    const submissionId = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.insert(submissions).values({
      id: submissionId,
      user_id: userId,
      problem_id: problemId,
      status: "finished",
      language: "python3",
      code: "print(1)",
      created_at: now,
    });
    await db.insert(evaluationResults).values({
      id: crypto.randomUUID(),
      submission_id: submissionId,
      status: "finished",
      score: 10000,
      created_at: now,
    });

    const problem = await getProblem(problemId);
    const visible = await applyAlgorithmTagVisibility(problem, { userId });

    assertEquals(visible.has_hidden_algorithm_tags, false);
    assertEquals(visible.tags.some((t) => t.kind === "algorithm"), true);

    await db.delete(evaluationResults).where(
      eq(evaluationResults.submission_id, submissionId),
    );
    await db.delete(submissions).where(eq(submissions.id, submissionId));
    await db.delete(problemTags).where(eq(problemTags.problem_id, problemId));
    await db.delete(problems).where(eq(problems.id, problemId));
    await db.delete(tags).where(eq(tags.id, algoTag.id));
    await db.delete(users).where(eq(users.id, userId));
  },
});

Deno.test({
  name: "problems-tags: 门控——admin 与题主始终可见",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const algoTag = await createTag({
      name: `门控A4-${ts}`,
      kind: "algorithm",
    });
    const ownerId = await createTestUser();
    const db = getDb();

    // 题主场景：owner_id = ownerId
    const ownedProblemId = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.insert(problems).values({
      id: ownedProblemId,
      title: `门控题主题-${ts}`,
      description: "描述",
      difficulty: "easy",
      runtime_config: null,
      is_objective: false,
      number: 950000 + (ts % 10000),
      owner_id: ownerId,
      type: "P",
      created_at: now,
      updated_at: now,
    });
    await syncProblemTags(ownedProblemId, [algoTag.id]);
    const owned = await getProblem(ownedProblemId);
    const ownerVisible = await applyAlgorithmTagVisibility(owned, {
      userId: ownerId,
    });
    assertEquals(ownerVisible.has_hidden_algorithm_tags, false);
    assertEquals(
      ownerVisible.tags.some((t) => t.kind === "algorithm"),
      true,
    );

    // admin 场景
    const adminVisible = await applyAlgorithmTagVisibility(owned, {
      userId: "someone-else",
      isAdmin: true,
    });
    assertEquals(adminVisible.has_hidden_algorithm_tags, false);
    assertEquals(adminVisible.tags.some((t) => t.kind === "algorithm"), true);

    await db.delete(problemTags).where(
      eq(problemTags.problem_id, ownedProblemId),
    );
    await db.delete(problems).where(eq(problems.id, ownedProblemId));
    await db.delete(tags).where(eq(tags.id, algoTag.id));
    await db.delete(users).where(eq(users.id, ownerId));
  },
});

Deno.test({
  name: "problems-tags: 门控——无算法标签时标志为 false",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const probTag = await createTag({ name: `门控P5-${ts}`, kind: "problem" });
    const problemId = await createTestProblem();
    await syncProblemTags(problemId, [probTag.id]);

    const problem = await getProblem(problemId);
    const visible = await applyAlgorithmTagVisibility(problem, {});

    assertEquals(visible.has_hidden_algorithm_tags, false);
    assertEquals(visible.tags.length, 1);

    const db = getDb();
    await db.delete(problemTags).where(eq(problemTags.problem_id, problemId));
    await db.delete(problems).where(eq(problems.id, problemId));
    await db.delete(tags).where(eq(tags.id, probTag.id));
  },
});

Deno.test({
  name: "problems-tags: cleanup",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const rows = await db.select().from(tags);
    for (const row of rows) {
      if (row.name.startsWith("门控") || row.name.startsWith("替换")) {
        await db.delete(problemTags).where(eq(problemTags.tag_id, row.id));
        await db.delete(tags).where(eq(tags.id, row.id));
      }
    }
  },
});
