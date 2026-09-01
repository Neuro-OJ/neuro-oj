import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq, inArray } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import {
  evaluationResults,
  objectiveSubmissions,
  problems,
  submissions,
  trainings,
  users,
} from "../../src/db/schema.ts";
import {
  addTrainingProblem,
  createTraining,
  deleteTraining,
  getTraining,
  listAllTrainings,
  listMyTrainings,
  listPublicTrainings,
  listTrainingProblems,
  listUserTrainings,
  removeTrainingProblem,
  reorderTrainingProblems,
  updateTraining,
} from "../../src/domains/catalog/index.ts";
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

Deno.test({
  name: "trainings service: CRUD 与可见性矩阵",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const owner = await createUser("train-owner");
    const other = await createUser("train-other");
    const db = getDb();

    const privateTraining = await createTraining(
      { title: "私有题单", visibility: "private" },
      owner,
    );
    const unlistedTraining = await createTraining(
      { title: "链接题单", visibility: "unlisted" },
      owner,
    );
    const publicTraining = await createTraining(
      { title: "公开题单", visibility: "unlisted" },
      owner,
    );
    await updateTraining(
      publicTraining.id,
      { visibility: "public" },
      owner,
      { isAdmin: true },
    );

    try {
      assertEquals(privateTraining.visibility, "private");
      assertEquals(unlistedTraining.visibility, "unlisted");

      await assertRejects(
        () => getTraining(privateTraining.id, other),
        NotFoundError,
      );
      assertEquals(
        (await getTraining(privateTraining.id, owner)).id,
        privateTraining.id,
      );
      assertEquals(
        (await getTraining(privateTraining.id, other, true)).id,
        privateTraining.id,
      );
      assertEquals(
        (await getTraining(unlistedTraining.id, other)).id,
        unlistedTraining.id,
      );
      assertEquals(
        (await getTraining(publicTraining.id)).id,
        publicTraining.id,
      );

      const publicList = await listPublicTrainings({ page: 1, perPage: 20 });
      assertEquals(
        publicList.data.some((t) => t.id === publicTraining.id),
        true,
      );
      assertEquals(
        publicList.data.some((t) => t.id === unlistedTraining.id),
        false,
      );

      const mine = await listMyTrainings(owner, { page: 1, perPage: 20 });
      assertEquals(mine.total, 3);

      const otherView = await listUserTrainings(owner, other);
      assertEquals(
        otherView.data.some((t) => t.id === publicTraining.id),
        true,
      );
      assertEquals(
        otherView.data.some((t) => t.id === privateTraining.id),
        false,
      );

      const ownerView = await listUserTrainings(owner, owner);
      assertEquals(ownerView.total, 3);

      const all = await listAllTrainings({ page: 1, perPage: 20 });
      assertEquals(
        all.data.some((t) => t.id === privateTraining.id),
        true,
      );

      await assertRejects(
        () => updateTraining(privateTraining.id, { title: "x" }, other),
        ForbiddenError,
      );
      const updated = await updateTraining(
        privateTraining.id,
        { title: "改名" },
        owner,
      );
      assertEquals(updated.title, "改名");

      // 自定义角色即使没有 write_any/admin，只要拥有 publish/pin 权限即可操作自己的题单
      const publishOwn = await updateTraining(
        unlistedTraining.id,
        { visibility: "public" },
        owner,
        { canPublish: true },
      );
      assertEquals(publishOwn.visibility, "public");
      const pinOwn = await updateTraining(
        unlistedTraining.id,
        { is_pinned: true },
        owner,
        { canPin: true },
      );
      assertEquals(pinOwn.is_pinned, true);

      await deleteTraining(privateTraining.id, owner);
      await assertRejects(
        () => getTraining(privateTraining.id, owner),
        NotFoundError,
      );
    } finally {
      await db.delete(trainings).where(eq(trainings.created_by, owner));
      await db.delete(users).where(eq(users.id, owner));
      await db.delete(users).where(eq(users.id, other));
    }
  },
});

Deno.test({
  name: "trainings service: 题目增删排序与进度聚合",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const owner = await createUser("train-problem-owner");
    const solver = await createUser("train-solver");
    const db = getDb();
    const now = new Date().toISOString();

    async function createProblem(
      number: number,
      isObjective = false,
    ): Promise<string> {
      const id = crypto.randomUUID();
      await db.insert(problems).values({
        id,
        title: `题单测试题 ${number}`,
        description: "测试题面",
        difficulty: "easy",
        runtime_config: isObjective ? null : {},
        number,
        owner_id: "0",
        type: "P",
        is_objective: isObjective,
        created_at: now,
        updated_at: now,
      });
      return id;
    }

    const training = await createTraining(
      { title: "进度题单", visibility: "unlisted" },
      owner,
    );
    const p1 = await createProblem(940001);
    const p2 = await createProblem(940002);
    const objective = await createProblem(940003, true);

    try {
      await addTrainingProblem(training.id, p2, undefined, owner);
      await addTrainingProblem(training.id, p1, 0, owner);
      let problemsList = await listTrainingProblems(training.id, solver);
      assertEquals(problemsList.map((p) => p.problem_id), [p1, p2]);
      assertEquals(problemsList.every((p) => p.accepted === false), true);

      await addTrainingProblem(training.id, objective, 2, owner);
      const subId = crypto.randomUUID();
      await db.insert(submissions).values({
        id: subId,
        user_id: solver,
        problem_id: p1,
        status: "finished",
        language: "python3",
        code: "print(1)",
        created_at: now,
      });
      await db.insert(evaluationResults).values({
        id: crypto.randomUUID(),
        submission_id: subId,
        status: "finished",
        score: 10000,
        output: "",
        time_ms: 1,
        memory_kb: 1,
        created_at: now,
      });
      await db.insert(objectiveSubmissions).values({
        id: crypto.randomUUID(),
        paper_id: objective,
        user_id: solver,
        submission_type: "practice",
        answers: {},
        status: "finished",
        score: 10000,
        details: {},
        created_at: now,
      });

      problemsList = await listTrainingProblems(training.id, solver);
      assertEquals(
        problemsList.find((p) => p.problem_id === p1)?.accepted,
        true,
      );
      assertEquals(
        problemsList.find((p) => p.problem_id === objective)?.accepted,
        true,
      );
      assertEquals(
        problemsList.find((p) => p.problem_id === p2)?.accepted,
        false,
      );

      await reorderTrainingProblems(
        training.id,
        [
          { problem_id: objective, position: 0 },
          { problem_id: p1, position: 1 },
          { problem_id: p2, position: 2 },
        ],
        owner,
      );
      problemsList = await listTrainingProblems(training.id, owner);
      assertEquals(problemsList.map((p) => p.problem_id), [objective, p1, p2]);

      await removeTrainingProblem(training.id, p2, owner);
      assertEquals((await listTrainingProblems(training.id, owner)).length, 2);

      await assertRejects(
        () => addTrainingProblem(training.id, p1, undefined, owner),
        ConflictError,
      );
    } finally {
      await db.delete(trainings).where(eq(trainings.id, training.id));
      const solverSubs = await db
        .select({ id: submissions.id })
        .from(submissions)
        .where(eq(submissions.user_id, solver));
      if (solverSubs.length > 0) {
        await db.delete(evaluationResults).where(
          inArray(
            evaluationResults.submission_id,
            solverSubs.map((s) => s.id),
          ),
        );
      }
      await db.delete(submissions).where(eq(submissions.user_id, solver));
      await db.delete(objectiveSubmissions).where(
        eq(objectiveSubmissions.user_id, solver),
      );
      await db.delete(users).where(eq(users.id, owner));
      await db.delete(users).where(eq(users.id, solver));
    }
  },
});
