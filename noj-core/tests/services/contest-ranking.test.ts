import { assertEquals, assertExists, assertRejects } from "jsr:@std/assert@^1";
import { eq, inArray } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import {
  contestParticipants,
  contestProblems,
  contests,
  evaluationResults,
  objectiveSubmissions,
  problems,
  submissions,
  users,
} from "../../src/db/schema.ts";
import { getContestRanking } from "../../src/domains/contest/index.ts";
import { ForbiddenError, UnauthorizedError } from "../../src/lib/errors.ts";

await resetDbForTest({ refreshRankings: true });

const baseTime = Date.now() - 3_600_000;
const atMinutes = (minutes: number) =>
  new Date(baseTime + minutes * 60_000).toISOString();

async function insertSubmission(
  contestId: string,
  userId: string,
  problemId: string,
  minute: number,
  score: number,
): Promise<void> {
  const id = crypto.randomUUID();
  const createdAt = atMinutes(minute);
  await getDb().insert(submissions).values({
    id,
    user_id: userId,
    problem_id: problemId,
    contest_id: contestId,
    language: "python3",
    code: "print(1)",
    file_name: "submission.py",
    status: "finished",
    created_at: createdAt,
  });
  await getDb().insert(evaluationResults).values({
    id: crypto.randomUUID(),
    submission_id: id,
    status: "finished",
    score,
    output: "",
    details: "{}",
    created_at: createdAt,
  });
}

async function insertUser(id: string, prefix: string): Promise<void> {
  const now = new Date().toISOString();
  await getDb().insert(users).values({
    id,
    username: `${prefix}-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`,
    email: `${prefix}-${Date.now()}-${
      crypto.randomUUID().slice(0, 6)
    }@example.com`,
    password_hash: "hash",
    created_at: now,
    updated_at: now,
  });
}

async function insertProblem(
  id: string,
  number: number,
  title: string,
): Promise<void> {
  const now = new Date().toISOString();
  await getDb().insert(problems).values({
    id,
    title,
    description: title,
    difficulty: "easy",
    runtime_config: {},
    number,
    owner_id: "0",
    type: "P",
    created_at: now,
    updated_at: now,
  });
}

Deno.test({
  name: "contest ranking: Kaggle 每题取最高分、总分求和、严格刷新时间排序",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const userA = crypto.randomUUID();
    const userB = crypto.randomUUID();
    const problemA = crypto.randomUUID();
    const problemB = crypto.randomUUID();
    const contestId = crypto.randomUUID();
    const now = new Date().toISOString();

    await insertUser(userA, "kaggle-a");
    await insertUser(userB, "kaggle-b");
    await insertProblem(problemA, 920101, "Kaggle 排名题 A");
    await insertProblem(problemB, 920102, "Kaggle 排名题 B");

    await db.insert(contests).values({
      id: contestId,
      title: "Kaggle 排名测试",
      start_time: atMinutes(-120),
      end_time: atMinutes(60),
      type: "kaggle",
      config: {},
      created_by: userA,
      created_at: now,
      updated_at: now,
    });
    await db.insert(contestProblems).values([
      {
        contest_id: contestId,
        problem_id: problemA,
        label: "A",
        sort_order: 0,
        score: 10000,
      },
      {
        contest_id: contestId,
        problem_id: problemB,
        label: "B",
        sort_order: 1,
        score: 10000,
      },
    ]);
    await db.insert(contestParticipants).values([
      { contest_id: contestId, user_id: userA, registered_at: atMinutes(0) },
      { contest_id: contestId, user_id: userB, registered_at: atMinutes(0) },
    ]);

    try {
      await insertSubmission(contestId, userA, problemA, 5, 5000);
      await insertSubmission(contestId, userA, problemA, 15, 8000);
      await insertSubmission(contestId, userA, problemA, 50, 6000);
      await insertSubmission(contestId, userA, problemB, 20, 10000);
      await insertSubmission(contestId, userB, problemA, 10, 10000);
      await insertSubmission(contestId, userB, problemB, 30, 9000);

      const ranking = await getContestRanking(contestId, "kaggle");
      assertEquals(ranking.length, 2);
      assertEquals(ranking[0].user_id, userB);
      assertEquals(ranking[0].total_score, 19000);
      assertEquals(ranking[1].user_id, userA);
      assertEquals(ranking[1].total_score, 18000);

      const rowA = ranking.find((row) => row.user_id === userA);
      assertExists(rowA);
      assertEquals(rowA.problem_scores[0].label, "A");
      assertEquals(rowA.problem_scores[0].best_score, 8000);
      assertEquals(rowA.problem_scores[0].attempts, 3);
      assertEquals(rowA.problem_scores[1].label, "B");
      assertEquals(rowA.problem_scores[1].best_score, 10000);
      assertEquals(rowA.problem_scores[1].attempts, 1);
    } finally {
      const submissionRows = await db.select({ id: submissions.id }).from(
        submissions,
      ).where(inArray(submissions.contest_id, [contestId]));
      if (submissionRows.length > 0) {
        await db.delete(evaluationResults).where(inArray(
          evaluationResults.submission_id,
          submissionRows.map((row) => row.id),
        ));
      }
      await db.delete(submissions).where(inArray(
        submissions.contest_id,
        [contestId],
      ));
      await db.delete(contests).where(eq(contests.id, contestId));
      await db.delete(problems).where(
        inArray(problems.id, [problemA, problemB]),
      );
      await db.delete(users).where(inArray(users.id, [userA, userB]));
    }
  },
});

Deno.test({
  name: "contest ranking: 同分时按最后严格刷新时间早者优先",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const userEarly = crypto.randomUUID();
    const userLate = crypto.randomUUID();
    const problemA = crypto.randomUUID();
    const problemB = crypto.randomUUID();
    const contestId = crypto.randomUUID();
    const now = new Date().toISOString();

    await insertUser(userEarly, "kaggle-early");
    await insertUser(userLate, "kaggle-late");
    await insertProblem(problemA, 920103, "平局排序题 A");
    await insertProblem(problemB, 920104, "平局排序题 B");

    await db.insert(contests).values({
      id: contestId,
      title: "Kaggle 平局排序测试",
      start_time: atMinutes(-120),
      end_time: atMinutes(60),
      type: "kaggle",
      config: {},
      created_by: userEarly,
      created_at: now,
      updated_at: now,
    });
    await db.insert(contestProblems).values([
      {
        contest_id: contestId,
        problem_id: problemA,
        label: "A",
        sort_order: 0,
        score: 10000,
      },
      {
        contest_id: contestId,
        problem_id: problemB,
        label: "B",
        sort_order: 1,
        score: 10000,
      },
    ]);
    await db.insert(contestParticipants).values([
      {
        contest_id: contestId,
        user_id: userEarly,
        registered_at: atMinutes(0),
      },
      {
        contest_id: contestId,
        user_id: userLate,
        registered_at: atMinutes(1),
      },
    ]);

    try {
      // 两人总分都是 15000；early 最后一次严格刷新在 20 分钟，late 在 30 分钟
      await insertSubmission(contestId, userEarly, problemA, 10, 10000);
      await insertSubmission(contestId, userEarly, problemB, 20, 5000);
      await insertSubmission(contestId, userLate, problemA, 5, 5000);
      await insertSubmission(contestId, userLate, problemB, 30, 10000);

      const ranking = await getContestRanking(contestId, "kaggle");
      assertEquals(ranking.map((row) => row.user_id), [userEarly, userLate]);
      assertEquals(ranking.map((row) => row.total_score), [15000, 15000]);
      assertEquals(ranking.map((row) => row.rank), [1, 2]);
    } finally {
      const submissionRows = await db.select({ id: submissions.id }).from(
        submissions,
      ).where(inArray(submissions.contest_id, [contestId]));
      if (submissionRows.length > 0) {
        await db.delete(evaluationResults).where(inArray(
          evaluationResults.submission_id,
          submissionRows.map((row) => row.id),
        ));
      }
      await db.delete(submissions).where(inArray(
        submissions.contest_id,
        [contestId],
      ));
      await db.delete(contests).where(eq(contests.id, contestId));
      await db.delete(problems).where(
        inArray(problems.id, [problemA, problemB]),
      );
      await db.delete(users).where(inArray(users.id, [userEarly, userLate]));
    }
  },
});

Deno.test({
  name: "contest ranking: 客观题提交计入排名",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const userFull = crypto.randomUUID();
    const userPartial = crypto.randomUUID();
    const paperId = crypto.randomUUID();
    const contestId = crypto.randomUUID();
    const now = new Date().toISOString();

    await insertUser(userFull, "obj-full");
    await insertUser(userPartial, "obj-partial");
    await db.insert(problems).values({
      id: paperId,
      title: "客观题排名卷",
      description: "客观题",
      difficulty: "easy",
      runtime_config: null,
      number: 920105,
      owner_id: "0",
      type: "U",
      is_objective: true,
      created_at: now,
      updated_at: now,
    });
    await db.insert(contests).values({
      id: contestId,
      title: "Kaggle 客观题排名测试",
      start_time: atMinutes(-120),
      end_time: atMinutes(60),
      type: "kaggle",
      config: {},
      created_at: now,
      updated_at: now,
    });
    await db.insert(contestProblems).values({
      contest_id: contestId,
      problem_id: paperId,
      label: "A",
      sort_order: 0,
      score: 10000,
    });
    await db.insert(contestParticipants).values([
      { contest_id: contestId, user_id: userFull, registered_at: atMinutes(0) },
      {
        contest_id: contestId,
        user_id: userPartial,
        registered_at: atMinutes(0),
      },
    ]);
    await db.insert(objectiveSubmissions).values([
      {
        id: crypto.randomUUID(),
        paper_id: paperId,
        user_id: userFull,
        contest_id: contestId,
        submission_type: "contest",
        answers: {},
        status: "finished",
        score: 10000,
        details: {},
        created_at: atMinutes(10),
      },
      {
        id: crypto.randomUUID(),
        paper_id: paperId,
        user_id: userPartial,
        contest_id: contestId,
        submission_type: "contest",
        answers: {},
        status: "finished",
        score: 6000,
        details: {},
        created_at: atMinutes(10),
      },
    ]);

    try {
      const ranking = await getContestRanking(contestId, "kaggle");
      const full = ranking.find((r) => r.user_id === userFull);
      const partial = ranking.find((r) => r.user_id === userPartial);
      assertExists(full);
      assertExists(partial);
      assertEquals(full.total_score, 10000);
      assertEquals(partial.total_score, 6000);
      assertEquals(ranking[0].user_id, userFull);
    } finally {
      await db.delete(objectiveSubmissions).where(
        eq(objectiveSubmissions.contest_id, contestId),
      );
      await db.delete(contests).where(eq(contests.id, contestId));
      await db.delete(problems).where(eq(problems.id, paperId));
      await db.delete(users).where(
        inArray(users.id, [userFull, userPartial]),
      );
    }
  },
});

Deno.test({
  name: "contest ranking: 进行中非管理员仅返回自己的排名",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const userA = crypto.randomUUID();
    const userB = crypto.randomUUID();
    const problemA = crypto.randomUUID();
    const contestId = crypto.randomUUID();
    const now = new Date().toISOString();

    await insertUser(userA, "kaggle-access-a");
    await insertUser(userB, "kaggle-access-b");
    await insertProblem(problemA, 920106, "访问控制题");

    await db.insert(contests).values({
      id: contestId,
      title: "Kaggle 访问控制测试",
      start_time: atMinutes(-60),
      end_time: atMinutes(120),
      type: "kaggle",
      config: {},
      created_by: userA,
      created_at: now,
      updated_at: now,
    });
    await db.insert(contestProblems).values({
      contest_id: contestId,
      problem_id: problemA,
      label: "A",
      sort_order: 0,
      score: 10000,
    });
    await db.insert(contestParticipants).values([
      { contest_id: contestId, user_id: userA, registered_at: atMinutes(0) },
      { contest_id: contestId, user_id: userB, registered_at: atMinutes(0) },
    ]);
    await insertSubmission(contestId, userA, problemA, 5, 8000);
    await insertSubmission(contestId, userB, problemA, 10, 7000);

    try {
      await assertRejects(
        () => getContestRanking(contestId, "kaggle"),
        UnauthorizedError,
        "竞赛进行期间需登录查看排名",
      );
      await assertRejects(
        () =>
          getContestRanking(contestId, "kaggle", false, crypto.randomUUID()),
        ForbiddenError,
        "仅参赛者可查看进行中的排名",
      );

      const own = await getContestRanking(contestId, "kaggle", false, userA);
      assertEquals(own.length, 1);
      assertEquals(own[0].user_id, userA);

      const admin = await getContestRanking(contestId, "kaggle", true);
      assertEquals(admin.length, 2);
    } finally {
      const submissionRows = await db.select({ id: submissions.id }).from(
        submissions,
      ).where(inArray(submissions.contest_id, [contestId]));
      if (submissionRows.length > 0) {
        await db.delete(evaluationResults).where(inArray(
          evaluationResults.submission_id,
          submissionRows.map((row) => row.id),
        ));
      }
      await db.delete(submissions).where(inArray(
        submissions.contest_id,
        [contestId],
      ));
      await db.delete(contests).where(eq(contests.id, contestId));
      await db.delete(problems).where(eq(problems.id, problemA));
      await db.delete(users).where(inArray(users.id, [userA, userB]));
    }
  },
});
