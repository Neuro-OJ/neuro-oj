import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import { problems, users } from "../../src/db/schema.ts";
import {
  addParticipants,
  computeContestStatus,
  createContest,
  deleteContest,
  getContest,
  getContestProblems,
  isParticipant,
  listContests,
  listParticipants,
  registerForContest,
  removeParticipant,
  updateContest,
} from "../../src/services/contests.ts";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../src/lib/errors.ts";

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
    title: `竞赛服务测试题 ${number}`,
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
        entry: "submission.py",
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

Deno.test({
  name: "contests service: CRUD、密码注册与参与者边界",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const creatorId = await createUser("contest-creator");
    const participantId = await createUser("contest-participant");
    const invitedId = await createUser("contest-invited");
    const problemA = await createProblem(910001);
    const problemB = await createProblem(910002);
    const startTime = new Date(Date.now() + 60_000).toISOString();
    const endTime = new Date(Date.now() + 3_600_000).toISOString();

    const contest = await createContest({
      title: "测试 ICPC 竞赛",
      start_time: startTime,
      end_time: endTime,
      type: "icpc",
      password: "ContestPass123",
      problems: [{
        problem_id: problemA,
        label: "A",
        sort_order: 0,
      }],
    }, creatorId);

    try {
      assertEquals(contest.status, "pending");
      assertEquals(contest.problem_count, 1);
      assertEquals(contest.has_password, true);
      assertEquals(computeContestStatus(startTime, endTime), "pending");

      const listed = await listContests({ page: 1, perPage: 20 });
      assertEquals(listed.data.some((item) => item.id === contest.id), true);

      await assertRejects(
        () => registerForContest(contest.id, participantId, "wrong"),
        ForbiddenError,
        "竞赛密码错误",
      );
      await registerForContest(contest.id, participantId, "ContestPass123");
      assertEquals(await isParticipant(contest.id, participantId), true);
      await assertRejects(
        () => registerForContest(contest.id, participantId, "ContestPass123"),
        ConflictError,
        "已注册该竞赛",
      );

      assertEquals(
        await addParticipants(contest.id, [invitedId, invitedId]),
        1,
      );
      assertEquals((await listParticipants(contest.id)).length, 2);
      await removeParticipant(contest.id, invitedId);
      assertEquals(await isParticipant(contest.id, invitedId), false);

      const updated = await updateContest(contest.id, {
        title: "已更新竞赛",
        password: null,
        problems: [
          { problem_id: problemA, label: "A", sort_order: 0 },
          { problem_id: problemB, label: "B", sort_order: 1 },
        ],
      });
      assertEquals(updated.title, "已更新竞赛");
      assertEquals(updated.has_password, false);
      assertEquals(updated.problem_count, 2);
      assertEquals(
        (await getContestProblems(contest.id, participantId)).length,
        2,
      );

      await deleteContest(contest.id);
      await assertRejects(
        () => getContest(contest.id),
        NotFoundError,
        "竞赛不存在",
      );
    } finally {
      await deleteContest(contest.id).catch(() => {});
      const db = getDb();
      await db.delete(problems).where(eq(problems.id, problemA));
      await db.delete(problems).where(eq(problems.id, problemB));
      await db.delete(users).where(eq(users.id, participantId));
      await db.delete(users).where(eq(users.id, invitedId));
      await db.delete(users).where(eq(users.id, creatorId));
    }
  },
});
