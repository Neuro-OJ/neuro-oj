import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import {
  communityPosts,
  contests,
  problems,
  users,
} from "../../../../shared/db/schema.ts";
import {
  endedContestTimes,
  pendingContestTimes,
  runningContestTimes,
  seedRunningContest,
} from "../../../../shared/testing/contest-fixtures.ts";
import {
  queryProfileCommunityStats,
  queryProfileSolutions,
} from "../../services/users/users-profile-queries.ts";

await resetDbForTest();

async function seedUser(prefix: string): Promise<string> {
  const id = crypto.randomUUID();
  const unique = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  await getDb().insert(users).values({
    id,
    username: `${prefix}-${unique}`,
    email: `${prefix}-${unique}@example.com`,
    password_hash: "hash",
    created_at: now,
    updated_at: now,
  });
  return id;
}

async function seedProblem(): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await getDb().insert(problems).values({
    id,
    title: `门控测试题 ${id.slice(0, 8)}`,
    description: "题面",
    difficulty: "easy",
    runtime_config: {},
    number: 950_000 + Math.floor(Math.random() * 10_000),
    type: "U",
    visibility: "public",
    created_at: now,
    updated_at: now,
  });
  return id;
}

async function seedSolution(
  authorId: string,
  problemId: string,
): Promise<void> {
  const now = new Date().toISOString();
  await getDb().insert(communityPosts).values({
    id: crypto.randomUUID(),
    type: "solution",
    author_id: authorId,
    problem_id: problemId,
    title: "题解标题（敏感：不得在赛前泄露）",
    content: "题解正文",
    status: "published",
    created_at: now,
    updated_at: now,
  });
}

/**
 * 个人主页的题解门控必须覆盖 **pending（赛前筹备期）**。
 *
 * 面 1.4 审计 F-01：本文件此前用 `runningContestExistsForProblem`（仅
 * `start ≤ now < end`），而社区/搜索已改用 `unended`（含 pending）口径 ——
 * 于是"题目已被未开始的公开赛收编"这一最严重的泄密阶段在个人主页上是敞开的：
 * 匿名即可读到题解**标题**与 `solution_count`。本用例把四种窗口一次锁死。
 */
Deno.test({
  name: "identity: 个人主页题解门控覆盖进行中与赛前筹备期（F-01 回归）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const author = await seedUser("profile-secrecy");
    const problemId = await seedProblem();
    await seedSolution(author, problemId);

    // A) 未被任何竞赛收编：可见（基线，证明后面的断言不是恒真）
    assertEquals(
      (await queryProfileSolutions(db, author)).length,
      1,
      "无竞赛时题解应可见",
    );
    assertEquals(
      (await queryProfileCommunityStats(db, author))?.solution_count,
      1,
      "无竞赛时计数应为 1",
    );

    // B) 进行中的公开赛收编：隐藏（2026-09-14 评审 High#1 的既有行为，回归守卫）
    const contestId = await seedRunningContest({
      problemIds: [problemId],
      times: runningContestTimes(),
    });
    assertEquals(
      (await queryProfileSolutions(db, author)).length,
      0,
      "进行中公开赛必须隐藏题解标题",
    );
    assertEquals(
      (await queryProfileCommunityStats(db, author))?.solution_count,
      0,
      "计数必须与列表同口径（否则数量本身即侧信道）",
    );

    // C) 竞赛结束：自动放行（赛后复盘）
    await db.update(contests).set({ ...endedContestTimes() }).where(
      eq(contests.id, contestId),
    );
    assertEquals(
      (await queryProfileSolutions(db, author)).length,
      1,
      "竞赛结束后应自动放行",
    );

    // D) **赛前筹备期（pending）**：必须与进行中同样隐藏 —— F-01 的修复点
    await seedRunningContest({
      problemIds: [problemId],
      times: pendingContestTimes(),
    });
    assertEquals(
      (await queryProfileSolutions(db, author)).length,
      0,
      "赛前筹备期不得泄露题解标题（F-01）",
    );
    assertEquals(
      (await queryProfileCommunityStats(db, author))?.solution_count,
      0,
      "赛前筹备期计数同样必须隐藏（F-01）",
    );
  },
});
