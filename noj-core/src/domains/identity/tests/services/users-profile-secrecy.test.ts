import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import {
  communityPosts,
  contests,
  evaluationResults,
  problems,
  submissions,
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
  queryProfileStats,
  querySolvedProblems,
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

/** 造一条"已通过"记录（submission + 满分评测结果），用于计数口径断言。 */
async function seedAcceptedSubmission(
  authorId: string,
  problemId: string,
): Promise<void> {
  const now = new Date().toISOString();
  const submissionId = crypto.randomUUID();
  await getDb().insert(submissions).values({
    id: submissionId,
    user_id: authorId,
    problem_id: problemId,
    language: "python3",
    code: "print(1)",
    status: "finished",
    // 个人主页通过口径读有效成绩投影；此处直接落投影
    is_valid: true,
    is_accepted: true,
    created_at: now,
  });
  await getDb().insert(evaluationResults).values({
    id: crypto.randomUUID(),
    submission_id: submissionId,
    status: "finished",
    score: 10000,
    created_at: now,
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
    await seedAcceptedSubmission(author, problemId);

    // A) 未被任何竞赛收编：可见（基线，证明后面的断言不是恒真）
    assertEquals(
      (await queryProfileSolutions(db, author)).length,
      1,
      "无竞赛时题解应可见",
    );
    assertEquals(
      Number((await queryProfileCommunityStats(db, author))?.solution_count),
      1,
      "无竞赛时计数应为 1",
    );
    assertEquals(
      Number((await queryProfileStats(db, author))?.solved_count),
      1,
      "无竞赛时 solved_count 应为 1",
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
      Number((await queryProfileCommunityStats(db, author))?.solution_count),
      0,
      "计数必须与列表同口径（否则数量本身即侧信道）",
    );
    assertEquals(
      Number((await queryProfileStats(db, author))?.solved_count),
      0,
      "solved_count 必须与已通过题目列表同口径（F-04a）",
    );
    assertEquals(
      (await querySolvedProblems(db, author)).length,
      0,
      "已通过题目列表同样被隐藏（与计数一致）",
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
    assertEquals(
      Number((await queryProfileStats(db, author))?.solved_count),
      1,
      "竞赛结束后 solved_count 应恢复",
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
      Number((await queryProfileCommunityStats(db, author))?.solution_count),
      0,
      "赛前筹备期计数同样必须隐藏（F-01）",
    );
    assertEquals(
      Number((await queryProfileStats(db, author))?.solved_count),
      0,
      "赛前筹备期 solved_count 同样必须隐藏（F-04a）",
    );

    // E) 特权查看者（管理员 / 主页本人）不受过滤：计数与列表**同时**放行，
    //    否则"特权看到列表但计数被扣"会造成新的口径不一致。
    assertEquals(
      (await queryProfileSolutions(db, author, true)).length,
      1,
      "审核员视图应保留题解",
    );
    assertEquals(
      Number(
        (await queryProfileStats(db, author, { isAdmin: true }))?.solved_count,
      ),
      1,
      "管理员视图应保留计数",
    );
    assertEquals(
      (await querySolvedProblems(db, author, { isAdmin: true })).length,
      1,
      "管理员视图应保留已通过题目行",
    );
  },
});
