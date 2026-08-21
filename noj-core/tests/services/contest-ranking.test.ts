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
import {
  getContestRanking,
  getIcpcRanking,
  getIoiRanking,
} from "../../src/services/contest/contest-ranking.ts";
import { ForbiddenError, UnauthorizedError } from "../../src/lib/errors.ts";

await resetDbForTest();

const baseTime = Date.now() - 3_600_000;
const atMinutes = (minutes: number) =>
  new Date(baseTime + minutes * 60_000).toISOString();

async function insertSubmission(
  contestId: string,
  userId: string,
  problemId: string,
  minute: number,
  status: "Accepted" | "WrongAnswer",
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
    status,
    score,
    output: "",
    details: "{}",
    created_at: createdAt,
  });
}

Deno.test({
  name: "contest ranking: ICPC 罚时、封榜与 IOI 最高分",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const userA = crypto.randomUUID();
    const userB = crypto.randomUUID();
    const problemA = crypto.randomUUID();
    const problemB = crypto.randomUUID();
    const icpcId = crypto.randomUUID();
    const ioiId = crypto.randomUUID();
    const oiId = crypto.randomUUID();
    const now = new Date().toISOString();

    await db.insert(users).values([
      {
        id: userA,
        username: `rank-a-${Date.now()}`,
        email: `rank-a-${Date.now()}@example.com`,
        password_hash: "hash",
        created_at: now,
        updated_at: now,
      },
      {
        id: userB,
        username: `rank-b-${Date.now()}`,
        email: `rank-b-${Date.now()}@example.com`,
        password_hash: "hash",
        created_at: now,
        updated_at: now,
      },
    ]);
    await db.insert(problems).values([
      {
        id: problemA,
        title: "排名题 A",
        description: "A",
        difficulty: "easy",
        runtime_config: {},
        number: 920001,
        owner_id: "0",
        type: "P",
        created_at: now,
        updated_at: now,
      },
      {
        id: problemB,
        title: "排名题 B",
        description: "B",
        difficulty: "easy",
        runtime_config: {},
        number: 920002,
        owner_id: "0",
        type: "P",
        created_at: now,
        updated_at: now,
      },
    ]);
    await db.insert(contests).values([
      {
        id: icpcId,
        title: "ICPC 排名测试",
        start_time: atMinutes(0),
        end_time: atMinutes(120),
        type: "icpc",
        config: {
          penalty_minutes: 20,
          freeze_time: atMinutes(12),
          unfreeze_after_end: true,
        },
        created_by: userA,
        created_at: now,
        updated_at: now,
      },
      {
        id: ioiId,
        title: "IOI 排名测试",
        start_time: atMinutes(0),
        end_time: atMinutes(120),
        type: "ioi",
        config: { show_ranking_live: true },
        created_by: userA,
        created_at: now,
        updated_at: now,
      },
      {
        id: oiId,
        title: "OI 排名测试",
        start_time: atMinutes(0),
        end_time: atMinutes(120),
        type: "oi",
        config: { show_ranking_live: false },
        created_by: userA,
        created_at: now,
        updated_at: now,
      },
    ]);
    for (const contestId of [icpcId, ioiId, oiId]) {
      await db.insert(contestProblems).values([
        {
          contest_id: contestId,
          problem_id: problemA,
          label: "A",
          sort_order: 0,
          score: contestId === icpcId ? null : 10000,
        },
        {
          contest_id: contestId,
          problem_id: problemB,
          label: "B",
          sort_order: 1,
          score: contestId === icpcId ? null : 10000,
        },
      ]);
      await db.insert(contestParticipants).values([
        { contest_id: contestId, user_id: userA, registered_at: atMinutes(0) },
        { contest_id: contestId, user_id: userB, registered_at: atMinutes(0) },
      ]);
    }

    try {
      await insertSubmission(icpcId, userA, problemA, 5, "WrongAnswer", 0);
      await insertSubmission(icpcId, userA, problemA, 15, "Accepted", 10000);
      await insertSubmission(icpcId, userA, problemA, 50, "WrongAnswer", 0);
      await insertSubmission(icpcId, userA, problemB, 20, "Accepted", 10000);
      await insertSubmission(icpcId, userB, problemA, 10, "Accepted", 10000);
      await insertSubmission(icpcId, userB, problemB, 30, "Accepted", 10000);

      const icpc = await getIcpcRanking(icpcId);
      const rowA = icpc.find((row) => row.user_id === userA);
      const rowB = icpc.find((row) => row.user_id === userB);
      assertExists(rowA);
      assertExists(rowB);
      assertEquals(rowA.penalty, 55);
      assertEquals(rowA.solved, 2);
      assertEquals(rowA.problem_details[0].attempts, 1);
      assertEquals(rowB.penalty, 40);
      assertEquals(rowB.rank, 1);

      const frozen = await getContestRanking(icpcId, "icpc");
      const frozenA = frozen.find((row) => row.user_id === userA);
      assertExists(frozenA);
      assertEquals("solved" in frozenA ? frozenA.solved : -1, 0);

      const ownFrozen = await getContestRanking(icpcId, "icpc", false, userA);
      const ownA = ownFrozen.find((row) => row.user_id === userA);
      assertExists(ownA);
      assertEquals("solved" in ownA ? ownA.solved : -1, 2);
      assertEquals(ownA.rank, frozenA.rank);

      const adminLive = await getContestRanking(icpcId, "icpc", true);
      const adminA = adminLive.find((row) => row.user_id === userA);
      assertExists(adminA);
      assertEquals("solved" in adminA ? adminA.solved : -1, 2);

      await insertSubmission(ioiId, userA, problemA, 10, "WrongAnswer", 5000);
      await insertSubmission(ioiId, userA, problemA, 30, "Accepted", 8000);
      await insertSubmission(ioiId, userA, problemA, 40, "WrongAnswer", 6000);
      await insertSubmission(ioiId, userB, problemA, 20, "Accepted", 7000);
      const ioi = await getIoiRanking(ioiId);
      const ioiA = ioi.find((row) => row.user_id === userA);
      assertExists(ioiA);
      assertEquals(ioiA.total_score, 8000);
      assertEquals(ioiA.problem_scores[0].attempts, 3);
      assertEquals(ioiA.rank, 1);

      await insertSubmission(oiId, userA, problemA, 10, "Accepted", 9000);
      await insertSubmission(oiId, userB, problemA, 20, "Accepted", 8000);
      await assertRejects(
        () => getContestRanking(oiId, "oi"),
        UnauthorizedError,
        "OI 竞赛进行期间需登录查看排名",
      );
      await assertRejects(
        () => getContestRanking(oiId, "oi", false, crypto.randomUUID()),
        ForbiddenError,
        "仅参赛者可查看进行中的 OI 排名",
      );
      const ownOiRanking = await getContestRanking(oiId, "oi", false, userB);
      assertEquals(ownOiRanking.length, 1);
      assertEquals(ownOiRanking[0].user_id, userB);
      const adminOiRanking = await getContestRanking(oiId, "oi", true);
      assertEquals(adminOiRanking.length, 2);
      assertEquals(adminOiRanking[0].user_id, userA);
    } finally {
      const submissionRows = await db.select({ id: submissions.id }).from(
        submissions,
      ).where(inArray(submissions.contest_id, [icpcId, ioiId, oiId]));
      if (submissionRows.length > 0) {
        await db.delete(evaluationResults).where(inArray(
          evaluationResults.submission_id,
          submissionRows.map((row) => row.id),
        ));
      }
      await db.delete(submissions).where(inArray(
        submissions.contest_id,
        [icpcId, ioiId, oiId],
      ));
      await db.delete(contests).where(
        inArray(contests.id, [icpcId, ioiId, oiId]),
      );
      await db.delete(problems).where(
        inArray(problems.id, [problemA, problemB]),
      );
      await db.delete(users).where(inArray(users.id, [userA, userB]));
    }
  },
});

Deno.test({
  name: "contest ranking: ICPC 同分时按报名时间和用户 ID 稳定排序",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const userIds = [
      "contest-ranking-tie-early",
      "contest-ranking-tie-late",
      "contest-ranking-tie-a",
      "contest-ranking-tie-b",
    ];
    const contestId = crypto.randomUUID();
    const problemId = crypto.randomUUID();
    const now = new Date().toISOString();

    await db.insert(users).values(userIds.map((id) => ({
      id,
      username: `${id}-${Date.now()}`,
      email: `${id}-${Date.now()}@example.com`,
      password_hash: "hash",
      created_at: now,
      updated_at: now,
    })));
    await db.insert(problems).values({
      id: problemId,
      title: "平局排序题",
      description: "A",
      difficulty: "easy",
      runtime_config: {},
      number: 920003,
      owner_id: "0",
      type: "P",
      created_at: now,
      updated_at: now,
    });
    await db.insert(contests).values({
      id: contestId,
      title: "ICPC 平局排序测试",
      start_time: atMinutes(0),
      end_time: atMinutes(120),
      type: "icpc",
      config: {},
      created_by: userIds[0],
      created_at: now,
      updated_at: now,
    });
    await db.insert(contestProblems).values({
      contest_id: contestId,
      problem_id: problemId,
      label: "A",
      sort_order: 0,
      score: null,
    });
    await db.insert(contestParticipants).values([
      {
        contest_id: contestId,
        user_id: userIds[0],
        registered_at: atMinutes(0),
      },
      {
        contest_id: contestId,
        user_id: userIds[1],
        registered_at: atMinutes(1),
      },
      {
        contest_id: contestId,
        user_id: userIds[2],
        registered_at: atMinutes(2),
      },
      {
        contest_id: contestId,
        user_id: userIds[3],
        registered_at: atMinutes(2),
      },
    ]);

    try {
      const ranking = await getIcpcRanking(contestId);
      assertEquals(
        ranking.map((row) => row.user_id),
        userIds,
      );
      assertEquals(ranking.map((row) => row.rank), [1, 2, 3, 4]);
    } finally {
      await db.delete(contests).where(eq(contests.id, contestId));
      await db.delete(problems).where(eq(problems.id, problemId));
      await db.delete(users).where(inArray(users.id, userIds));
    }
  },
});

Deno.test({
  name:
    "contest ranking: 客观题提交计入排名（满分 Accepted / 非满分 WrongAnswer）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const userFull = `obj-rank-full-${Date.now()}`;
    const userPartial = `obj-rank-partial-${Date.now()}`;
    const contestId = crypto.randomUUID();
    const paperId = crypto.randomUUID();
    const now = new Date().toISOString();

    await db.insert(users).values([
      {
        id: userFull,
        username: userFull,
        email: `${userFull}@example.com`,
        password_hash: "hash",
        created_at: now,
        updated_at: now,
      },
      {
        id: userPartial,
        username: userPartial,
        email: `${userPartial}@example.com`,
        password_hash: "hash",
        created_at: now,
        updated_at: now,
      },
    ]);
    // 客观题套卷（type='O'，无 runtime_config）
    await db.insert(problems).values({
      id: paperId,
      title: "客观题排名卷",
      description: "客观题",
      difficulty: "easy",
      runtime_config: null,
      number: 920004,
      owner_id: "0",
      type: "U",
      is_objective: true,
      created_at: now,
      updated_at: now,
    });
    await db.insert(contests).values({
      id: contestId,
      title: "ICPC 客观题排名测试",
      start_time: atMinutes(0),
      end_time: atMinutes(120),
      type: "icpc",
      config: {},
      created_at: now,
      updated_at: now,
    });
    await db.insert(contestProblems).values({
      contest_id: contestId,
      problem_id: paperId,
      label: "A",
      sort_order: 0,
      score: null,
    });
    await db.insert(contestParticipants).values([
      { contest_id: contestId, user_id: userFull, registered_at: atMinutes(0) },
      {
        contest_id: contestId,
        user_id: userPartial,
        registered_at: atMinutes(0),
      },
    ]);
    // 满分提交（×100 整数 10000）与非满分提交（6000）
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
      const ranking = await getIcpcRanking(contestId);
      const full = ranking.find((r) => r.user_id === userFull);
      const partial = ranking.find((r) => r.user_id === userPartial);
      // 满分 → solved=1，罚时 = 解答分钟数
      assertEquals(full?.solved, 1);
      assertEquals(full?.penalty, 10);
      // 非满分 → 视为 WA：solved=0、未解题不计罚时（ICPC 规则），
      // 失败尝试计入 problem_details.attempts
      assertEquals(partial?.solved, 0);
      assertEquals(partial?.penalty, 0);
      const partialDetail = partial?.problem_details.find(
        (d) => d.label === "A",
      );
      assertEquals(partialDetail?.attempts, 1);
      // 满分者排前
      assertEquals(ranking[0].user_id, userFull);
    } finally {
      await db.delete(contests).where(eq(contests.id, contestId));
      await db.delete(problems).where(eq(problems.id, paperId));
      await db.delete(users).where(
        inArray(users.id, [userFull, userPartial]),
      );
    }
  },
});
