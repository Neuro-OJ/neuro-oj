import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { problems, users } from "../../../../shared/db/schema.ts";
import {
  addParticipants,
  createContest,
  deleteContest,
  verifyContestAccess,
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
    title: `竞赛访问测试题 ${number}`,
    description: "测试题面",
    difficulty: "easy",
    runtime_config: {
      evaluator: {
        image: "noj-evaluator-python",
        command: "python3 /workspace/evaluate.py",
        time_limit_ms: 5000,
        memory_limit_mb: 512,
      },
      solution: {
        image: "noj-solution-python",
        call_timeout_ms: 2000,
        memory_limit_mb: 512,
      },
    },
    number,
    owner_id: "0",
    type: "P",
    created_at: now,
    updated_at: now,
  });
  return id;
}

async function createContestWithStatus(
  startOffsetMs: number,
  endOffsetMs: number,
  problemId: string,
  creatorId: string,
): Promise<string> {
  const contest = await createContest({
    title: `竞赛访问测试 ${Date.now()}_${
      Math.random().toString(36).slice(2, 8)
    }`,
    start_time: new Date(Date.now() + startOffsetMs).toISOString(),
    end_time: new Date(Date.now() + endOffsetMs).toISOString(),
    type: "kaggle",
    password: "InvitePass123",
    problems: [{
      problem_id: problemId,
      label: "A",
      sort_order: 0,
      score: 10000,
    }],
  }, creatorId);
  return contest.id;
}

Deno.test({
  name: "contest-access: running + 参赛者 → allowed",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const creatorId = await createUser("ca-creator-1");
    const participantId = await createUser("ca-participant-1");
    const problemId = await createProblem(920001);
    const contestId = await createContestWithStatus(
      -60_000,
      60_000,
      problemId,
      creatorId,
    );
    try {
      await addParticipants(contestId, [participantId]);
      const info = await verifyContestAccess(
        participantId,
        contestId,
        problemId,
      );
      assertEquals(info.allowed, true);
      assertEquals(info.running, true);
      assertEquals(info.contestId, contestId);
    } finally {
      await deleteContest(contestId).catch(() => {});
      const db = getDb();
      await db.delete(problems).where(eq(problems.id, problemId));
      await db.delete(users).where(eq(users.id, participantId));
      await db.delete(users).where(eq(users.id, creatorId));
    }
  },
});

Deno.test({
  name: "contest-access: ended + 参赛者 → allowed（复盘）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const creatorId = await createUser("ca-creator-2");
    const participantId = await createUser("ca-participant-2");
    const problemId = await createProblem(920002);
    const contestId = await createContestWithStatus(
      -120_000,
      -60_000,
      problemId,
      creatorId,
    );
    try {
      await addParticipants(contestId, [participantId]);
      const info = await verifyContestAccess(
        participantId,
        contestId,
        problemId,
      );
      assertEquals(info.allowed, true);
      assertEquals(info.running, false);
    } finally {
      await deleteContest(contestId).catch(() => {});
      const db = getDb();
      await db.delete(problems).where(eq(problems.id, problemId));
      await db.delete(users).where(eq(users.id, participantId));
      await db.delete(users).where(eq(users.id, creatorId));
    }
  },
});

Deno.test({
  name: "contest-access: 赛前 → 拒绝",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const creatorId = await createUser("ca-creator-3");
    const participantId = await createUser("ca-participant-3");
    const problemId = await createProblem(920003);
    const contestId = await createContestWithStatus(
      60_000,
      120_000,
      problemId,
      creatorId,
    );
    try {
      await addParticipants(contestId, [participantId]);
      const info = await verifyContestAccess(
        participantId,
        contestId,
        problemId,
      );
      assertEquals(info.allowed, false);
      assertEquals(info.running, false);
    } finally {
      await deleteContest(contestId).catch(() => {});
      const db = getDb();
      await db.delete(problems).where(eq(problems.id, problemId));
      await db.delete(users).where(eq(users.id, participantId));
      await db.delete(users).where(eq(users.id, creatorId));
    }
  },
});

Deno.test({
  name: "contest-access: 非参赛者 → 拒绝",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const creatorId = await createUser("ca-creator-4");
    const participantId = await createUser("ca-participant-4");
    const strangerId = await createUser("ca-stranger-4");
    const problemId = await createProblem(920004);
    const contestId = await createContestWithStatus(
      -60_000,
      60_000,
      problemId,
      creatorId,
    );
    try {
      await addParticipants(contestId, [participantId]);
      const info = await verifyContestAccess(
        strangerId,
        contestId,
        problemId,
      );
      assertEquals(info.allowed, false);
    } finally {
      await deleteContest(contestId).catch(() => {});
      const db = getDb();
      await db.delete(problems).where(eq(problems.id, problemId));
      await db.delete(users).where(eq(users.id, strangerId));
      await db.delete(users).where(eq(users.id, participantId));
      await db.delete(users).where(eq(users.id, creatorId));
    }
  },
});
