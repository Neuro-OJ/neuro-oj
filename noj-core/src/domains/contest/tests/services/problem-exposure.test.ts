import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { contests, problems, users } from "../../../../shared/db/schema.ts";
import {
  createContest,
  deleteContest,
  filterProblemsInRunningContest,
  isProblemInRunningContest,
} from "../../index.ts";

await resetDbForTest();

async function createUser(prefix: string): Promise<string> {
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

async function createProblem(number: number): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await getDb().insert(problems).values({
    id,
    title: `暴露判定测试题 ${number}`,
    description: "题面",
    difficulty: "easy",
    runtime_config: {},
    number,
    type: "U",
    visibility: "public",
    created_at: now,
    updated_at: now,
  });
  return id;
}

async function createContestWithWindow(
  startOffsetMs: number,
  endOffsetMs: number,
  problemIds: string[],
  creatorId: string,
): Promise<string> {
  const contest = await createContest(
    {
      title: `暴露判定 ${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      start_time: new Date(Date.now() + startOffsetMs).toISOString(),
      end_time: new Date(Date.now() + endOffsetMs).toISOString(),
      type: "kaggle",
      problems: problemIds.map((problemId, index) => ({
        problem_id: problemId,
        label: String.fromCharCode(65 + index),
        sort_order: index,
        score: 10000,
      })),
    },
    creatorId,
    true,
  );
  return contest.id;
}

async function cleanup(
  contestIds: string[],
  problemIds: string[],
  userIds: string[],
): Promise<void> {
  for (const id of contestIds) await deleteContest(id).catch(() => {});
  for (const id of problemIds) {
    await getDb().delete(problems).where(eq(problems.id, id)).catch(() => {});
  }
  for (const id of userIds) {
    await getDb().delete(users).where(eq(users.id, id)).catch(() => {});
  }
}

Deno.test({
  name: "problem-exposure: running 竞赛内的题目被标记为暴露",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const creatorId = await createUser("pe-creator-1");
    const problemId = await createProblem(930001);
    const contestId = await createContestWithWindow(
      -60_000,
      60_000,
      [problemId],
      creatorId,
    );
    try {
      assertEquals(await isProblemInRunningContest(problemId), true);
    } finally {
      await cleanup([contestId], [problemId], [creatorId]);
    }
  },
});

Deno.test({
  name: "problem-exposure: pending 与 ended 竞赛不算暴露",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const creatorId = await createUser("pe-creator-2");
    const pendingProblem = await createProblem(930002);
    const endedProblem = await createProblem(930003);
    const pendingContest = await createContestWithWindow(
      60_000,
      120_000,
      [pendingProblem],
      creatorId,
    );
    const endedContest = await createContestWithWindow(
      -120_000,
      -60_000,
      [endedProblem],
      creatorId,
    );
    try {
      assertEquals(await isProblemInRunningContest(pendingProblem), false);
      assertEquals(await isProblemInRunningContest(endedProblem), false);
    } finally {
      await cleanup(
        [pendingContest, endedContest],
        [pendingProblem, endedProblem],
        [creatorId],
      );
    }
  },
});

Deno.test({
  name: "problem-exposure: 不在任何竞赛的题目不算暴露",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const problemId = await createProblem(930004);
    try {
      assertEquals(await isProblemInRunningContest(problemId), false);
      assertEquals((await filterProblemsInRunningContest([problemId])).size, 0);
      // 空输入不应产生空 IN 查询
      assertEquals((await filterProblemsInRunningContest([])).size, 0);
    } finally {
      await cleanup([], [problemId], []);
    }
  },
});

Deno.test({
  name: "problem-exposure: 批量判定只返回处于进行中竞赛的题目",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const creatorId = await createUser("pe-creator-3");
    const exposed = await createProblem(930005);
    const quiet = await createProblem(930006);
    const contestId = await createContestWithWindow(
      -60_000,
      60_000,
      [exposed],
      creatorId,
    );
    try {
      const result = await filterProblemsInRunningContest([exposed, quiet]);
      assertEquals(result.has(exposed), true);
      assertEquals(result.has(quiet), false);
      assertEquals(result.size, 1);
    } finally {
      await cleanup([contestId], [exposed, quiet], [creatorId]);
    }
  },
});

Deno.test({
  name: "problem-exposure: 同一题在 ended 与 running 两场竞赛中时仍算暴露",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const creatorId = await createUser("pe-creator-4");
    const problemId = await createProblem(930007);
    const endedContest = await createContestWithWindow(
      -120_000,
      -60_000,
      [problemId],
      creatorId,
    );
    const runningContest = await createContestWithWindow(
      -30_000,
      60_000,
      [problemId],
      creatorId,
    );
    try {
      assertEquals(await isProblemInRunningContest(problemId), true);
    } finally {
      await cleanup([endedContest, runningContest], [problemId], [creatorId]);
    }
  },
});

Deno.test({
  name: "problem-exposure: 竞赛结束后暴露自动解除（无调度依赖）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const creatorId = await createUser("pe-creator-5");
    const problemId = await createProblem(930008);
    const contestId = await createContestWithWindow(
      -60_000,
      60_000,
      [problemId],
      creatorId,
    );
    try {
      assertEquals(await isProblemInRunningContest(problemId), true);
      // 直接把结束时间改到过去，模拟竞赛结束：判定应实时翻转，无需任何调度
      await getDb().update(contests)
        .set({ end_time: new Date(Date.now() - 1_000).toISOString() })
        .where(eq(contests.id, contestId));
      assertEquals(await isProblemInRunningContest(problemId), false);
    } finally {
      await cleanup([contestId], [problemId], [creatorId]);
    }
  },
});
