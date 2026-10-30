import { deleteProblemFixtures } from "../../../../../tests/helper.ts";
import { DEFAULT_DOMAIN_ID } from "../../../../shared/workspace/types.ts";
import { assertEquals, assertMatch, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import { resetDbForTest } from "../../../../../tests/helpers/db.ts";
import {
  contestProblems as contestProblemRows,
  problems,
  users,
} from "../../../../shared/db/schema.ts";
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
  resolveContestId,
  updateContest,
} from "../../index.ts";
import {
  ConflictError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import { publishBaselineVersionForTest } from "../../../../../tests/helper.ts";

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
    domain_id: DEFAULT_DOMAIN_ID,
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
        call_timeout_ms: 2000,
        memory_limit_mb: 512,
      },
    },
    number,
    owner_id: "0",
    created_at: now,
    updated_at: now,
  });
  // 竞赛只能固定已发布版本（Handbook §2.6）：夹具题目补迁移基线
  await publishBaselineVersionForTest(id);
  return id;
}

Deno.test({
  name: "contests service: CRUD、统一报名与参与者边界",
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
      title: "测试 Kaggle 竞赛",
      start_time: startTime,
      end_time: endTime,
      type: "kaggle",
      password: "ContestPass123",
      problems: [{
        problem_id: problemA,
        label: "A",
        sort_order: 0,
        score: 10000,
      }],
    }, creatorId);

    try {
      assertEquals(contest.status, "pending");
      assertEquals(contest.kind, "public");
      assertEquals(contest.is_public, true);
      assertEquals(contest.problem_count, 1);
      assertEquals(contest.has_password, false);
      const [binding] = await getDb().select().from(contestProblemRows).where(
        eq(contestProblemRows.contest_id, contest.id),
      );
      assertEquals(binding.domain_id, DEFAULT_DOMAIN_ID);
      assertEquals(
        binding.domain_problem_binding_id,
        `owned-binding-${problemA}`,
      );
      assertMatch(
        contest.public_id,
        /^ct-[123456789abcdefghjkmnpqrstuvwxyz]{8}$/,
      );
      assertEquals(await resolveContestId(contest.public_id), contest.id);
      assertEquals(await resolveContestId(contest.id), contest.id);
      assertEquals(computeContestStatus(startTime, endTime), "pending");

      // 已进入默认域的用户按统一规则发现比赛。
      const listed = await listContests({ page: 1, perPage: 20 });
      assertEquals(listed.data.some((item) => item.id === contest.id), true);

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
        password: "RotatedPass123",
        problems: [
          { problem_id: problemA, label: "A", sort_order: 0, score: 10000 },
          { problem_id: problemB, label: "B", sort_order: 1, score: 10000 },
        ],
      });
      assertEquals(updated.title, "已更新竞赛");
      assertEquals(updated.has_password, false);
      assertEquals(updated.problem_count, 2);
      await registerForContest(contest.id, invitedId, "RotatedPass123");
      const contestProblems = await getContestProblems(
        contest.id,
        participantId,
      );
      assertEquals(contestProblems.length, 2);
      assertEquals(contestProblems[0].judge_backend, "dual");
      assertEquals(contestProblems[0].is_objective, false);

      await deleteContest(contest.id);
      await assertRejects(
        () => getContest(contest.id),
        NotFoundError,
        "竞赛不存在",
      );
    } finally {
      await deleteContest(contest.id).catch(() => {});
      const db = getDb();
      await deleteProblemFixtures(eq(problems.id, problemA));
      await deleteProblemFixtures(eq(problems.id, problemB));
      await db.update(users).set({ deleted_at: new Date().toISOString() })
        .where(eq(users.id, participantId));
      await db.update(users).set({ deleted_at: new Date().toISOString() })
        .where(eq(users.id, invitedId));
      await db.update(users).set({ deleted_at: new Date().toISOString() })
        .where(eq(users.id, creatorId));
    }
  },
});

Deno.test({
  name: "contests service: 旧分类与密码字段不再建立额外隔离",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const creator = await createUser("unified-owner");
    const participant = await createUser("unified-participant");
    const problemId = await createProblem(950002);
    const contest = await createContest({
      title: "统一域比赛",
      start_time: new Date(Date.now() + 60_000).toISOString(),
      end_time: new Date(Date.now() + 3_600_000).toISOString(),
      type: "kaggle",
      kind: "invite",
      is_public: false,
      password: "discarded",
      problems: [{
        problem_id: problemId,
        label: "A",
        sort_order: 0,
        score: 10000,
      }],
    }, creator);
    try {
      assertEquals(contest.has_password, false);
      assertEquals(contest.secrecy_enabled, true);
      await registerForContest(contest.id, participant);
      assertEquals(await isParticipant(contest.id, participant), true);
      const updated = await updateContest(contest.id, {
        kind: "invite",
        password: null,
        secrecy_enabled: false,
      });
      assertEquals(updated.has_password, false);
      assertEquals(updated.secrecy_enabled, false);
      assertEquals((await getContest(contest.id)).secrecy_enabled, false);
    } finally {
      await deleteContest(contest.id);
      await deleteProblemFixtures(eq(problems.id, problemId));
    }
  },
});
