import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { bindPublishedProblemForTest } from "../../../../../tests/helper.ts";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  objectiveSubmissions,
  problems,
  submissions,
  trainings,
  users,
} from "../../../../shared/db/schema.ts";
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
} from "../../index.ts";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";

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
  await grantDefaultCatalogRole(
    id,
    prefix.includes("owner") ? "editor" : "member",
  );
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
        (await getTraining(privateTraining.id, "0")).id,
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

      const all = await listAllTrainings({ page: 1, perPage: 20 }, "0");
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
        "0",
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
      await removeDefaultCatalogMembership(owner);
      await db.delete(users).where(eq(users.id, owner));
      await removeDefaultCatalogMembership(other);
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
        domain_id: "00000000-0000-4000-8000-000000000001",
        id,
        title: `题单测试题 ${number}`,
        description: "测试题面",
        difficulty: "easy",
        runtime_config: isObjective ? null : {},
        number,
        owner_id: "0",
        is_objective: isObjective,
        created_at: now,
        updated_at: now,
      });
      await publishDefaultCatalogFixture(id);
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
        domain_id: "00000000-0000-4000-8000-000000000001",
        domain_problem_binding_id: await bindPublishedProblemForTest(p1),
        id: subId,
        user_id: solver,
        problem_id: p1,
        status: "finished",
        language: "python3",
        code: "print(1)",
        // 进度读有效成绩投影（由结果服务维护）；此处直接落投影
        is_valid: true,
        is_accepted: true,
        created_at: now,
      });
      await db.insert(objectiveSubmissions).values({
        domain_id: "00000000-0000-4000-8000-000000000001",
        domain_problem_binding_id: await bindPublishedProblemForTest(objective),
        id: crypto.randomUUID(),
        paper_id: objective,
        user_id: solver,
        submission_type: "practice",
        answers: {},
        status: "finished",
        score: 10000,
        details: {},
        // 客观题进度同样读有效成绩投影：满分通过由提交写入服务落 `is_accepted`
        is_valid: true,
        is_accepted: true,
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
      await db.delete(submissions).where(eq(submissions.user_id, solver));
      await db.delete(objectiveSubmissions).where(
        eq(objectiveSubmissions.user_id, solver),
      );
      await removeDefaultCatalogMembership(owner);
      await db.delete(users).where(eq(users.id, owner));
      await removeDefaultCatalogMembership(solver);
      await db.delete(users).where(eq(users.id, solver));
    }
  },
});

Deno.test({
  name: "trainings service: 普通用户不能把他人 private 题加入题单",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const owner = await createUser("train-priv-owner");
    const other = await createUser("train-priv-other");
    const db = getDb();
    const now = new Date().toISOString();
    const privateProblemId = crypto.randomUUID();
    await db.insert(problems).values({
      domain_id: "00000000-0000-4000-8000-000000000001",
      id: privateProblemId,
      title: "他人私有题",
      description: "私有题面",
      difficulty: "easy",
      visibility: "private",
      runtime_config: {},
      number: 940010,
      owner_id: other,
      created_at: now,
      updated_at: now,
    });
    const training = await createTraining(
      { title: "私有题测试题单", visibility: "unlisted" },
      owner,
    );
    try {
      await assertRejects(
        () =>
          addTrainingProblem(training.id, privateProblemId, undefined, owner),
        NotFoundError,
      );
    } finally {
      await db.delete(trainings).where(eq(trainings.id, training.id));
      await db.delete(problems).where(eq(problems.id, privateProblemId));
      await removeDefaultCatalogMembership(owner);
      await db.delete(users).where(eq(users.id, owner));
      await removeDefaultCatalogMembership(other);
      await db.delete(users).where(eq(users.id, other));
    }
  },
});

import {
  grantDefaultCatalogRole,
  publishDefaultCatalogFixture,
  removeDefaultCatalogMembership,
  resetDbForTest,
} from "../default-fixture.ts";
