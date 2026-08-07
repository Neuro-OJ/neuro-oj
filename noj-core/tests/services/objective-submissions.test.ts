/**
 * 客观题提交服务层测试（DB-backed）。
 * 覆盖：练习重复提交取最高分、竞赛一次性提交与校验失败路径、
 * 提交详情权限、练习/竞赛模式解析可见性、非 O 型拒绝。
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { and, eq } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import {
  contestParticipants,
  contestProblems,
  contests,
  objectiveQuestions,
  objectiveSubmissions,
  problems,
  users,
} from "../../src/db/schema.ts";
import {
  getObjectiveSubmission,
  listObjectiveSubmissions,
  submitObjectivePaper,
} from "../../src/services/objective-submissions.ts";
import { BadRequestError, ForbiddenError } from "../../src/lib/errors.ts";

await resetDbForTest();
const db = getDb();
const ts = Date.now();

/** 创建用户，返回 id。 */
async function makeUser(tag: string): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(users).values({
    id,
    username: `obj-${tag}-${ts}-${id.slice(0, 6)}`,
    email: `obj-${tag}-${ts}-${id.slice(0, 6)}@test.local`,
    password_hash: "hash",
    created_at: now,
    updated_at: now,
  });
  return id;
}

/** 创建客观题套卷，返回 id。 */
async function makePaper(ownerId: string): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(problems).values({
    id,
    title: `客观题卷 ${ts} ${id.slice(0, 6)}`,
    description: "测试套卷",
    difficulty: "easy",
    runtime_config: null,
    number: Math.floor(Math.random() * 90000) + 10000,
    owner_id: ownerId,
    type: "O",
    created_at: now,
    updated_at: now,
  });
  return id;
}

/** 创建编程题（非 O 型，用于拒绝路径）。 */
async function makeCodeProblem(): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(problems).values({
    id,
    title: `编程题 ${ts}`,
    description: "code",
    difficulty: "easy",
    runtime_config: {},
    number: Math.floor(Math.random() * 90000) + 10000,
    owner_id: "0",
    type: "U",
    created_at: now,
    updated_at: now,
  });
  return id;
}

/** 创建小题并返回 {id, sort_order}。 */
async function makeQuestion(
  paperId: string,
  sortOrder: number,
  type: "single" | "multiple" | "judge",
  answer: unknown[],
  explanation = "",
): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(objectiveQuestions).values({
    id,
    paper_id: paperId,
    sort_order: sortOrder,
    type,
    prompt: `题目 ${sortOrder}`,
    options: type === "judge"
      ? [{ key: "true", text: "正确" }, { key: "false", text: "错误" }]
      : [{ key: "A", text: "A" }, { key: "B", text: "B" }, {
        key: "C",
        text: "C",
      }],
    answer,
    explanation,
    created_at: now,
    updated_at: now,
  });
  return id;
}

Deno.test({
  name: "objective submissions: 练习模式全对得满分并落库",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const owner = await makeUser("owner");
    const user = await makeUser("practice");
    const paper = await makePaper(owner);
    const q1 = await makeQuestion(paper, 1, "single", ["A"], "解析1");

    const result = await submitObjectivePaper(paper, {
      answers: { [q1]: ["A"] },
    }, user);

    assertEquals(result.score, 100);
    assertEquals(result.score_db, 10000);
    assertEquals(result.correct_count, 1);
    assertEquals(result.contest_mode, false);
    // 练习模式含解析
    assertEquals(result.details[q1].explanation, "解析1");

    const rows = await db.select().from(objectiveSubmissions).where(
      eq(objectiveSubmissions.paper_id, paper),
    );
    assertEquals(rows.length, 1);
    assertEquals(rows[0].status, "finished");
    assertEquals(rows[0].submission_type, "practice");
    assertEquals(rows[0].contest_id, null);
  },
});

Deno.test({
  name: "objective submissions: 练习重复提交，最高分取 MAX(score)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const owner = await makeUser("owner");
    const user = await makeUser("practice2");
    const paper = await makePaper(owner);
    const q1 = await makeQuestion(paper, 1, "single", ["A"]);

    const first = await submitObjectivePaper(paper, {
      answers: { [q1]: ["B"] },
    }, user);
    assertEquals(first.score, 0);

    const second = await submitObjectivePaper(paper, {
      answers: { [q1]: ["A"] },
    }, user);
    assertEquals(second.score, 100);

    const list = await listObjectiveSubmissions({
      viewerId: user,
      paperId: paper,
      page: 1,
      perPage: 20,
    });
    assertEquals(list.total, 2);
    assertEquals(list.best_score, 10000);
  },
});

Deno.test({
  name: "objective submissions: 竞赛模式一次性提交（第二次被拒）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const owner = await makeUser("owner");
    const user = await makeUser("contestant");
    const paper = await makePaper(owner);
    const q1 = await makeQuestion(paper, 1, "single", ["A"]);

    const now = new Date().toISOString();
    const contestId = crypto.randomUUID();
    await db.insert(contests).values({
      id: contestId,
      title: `客观题竞赛 ${ts}`,
      description: "",
      start_time: new Date(Date.now() - 3600_000).toISOString(),
      end_time: new Date(Date.now() + 3600_000).toISOString(),
      type: "icpc",
      config: {},
      created_at: now,
      updated_at: now,
    });
    await db.insert(contestParticipants).values({
      contest_id: contestId,
      user_id: user,
      registered_at: now,
    });
    await db.insert(contestProblems).values({
      contest_id: contestId,
      problem_id: paper,
      sort_order: 1,
      label: "A",
    });

    const first = await submitObjectivePaper(paper, {
      answers: { [q1]: ["A"] },
      contest_id: contestId,
    }, user);
    assertEquals(first.contest_mode, true);
    assertEquals(first.details[q1].explanation, undefined); // 竞赛模式无解析

    // 第二次提交被拒（先查后插 + 唯一索引兜底）
    await assertRejects(
      () =>
        submitObjectivePaper(paper, {
          answers: { [q1]: ["A"] },
          contest_id: contestId,
        }, user),
      BadRequestError,
    );

    const rows = await db.select().from(objectiveSubmissions).where(
      and(
        eq(objectiveSubmissions.paper_id, paper),
        eq(objectiveSubmissions.contest_id, contestId),
      ),
    );
    assertEquals(rows.length, 1);
  },
});

Deno.test({
  name: "objective submissions: 竞赛校验失败路径（未注册 / 不在题单 / 未开始）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const owner = await makeUser("owner");
    const stranger = await makeUser("stranger");
    const user = await makeUser("contestant2");
    const paper = await makePaper(owner);
    const q1 = await makeQuestion(paper, 1, "single", ["A"]);

    const now = new Date().toISOString();
    const contestId = crypto.randomUUID();
    await db.insert(contests).values({
      id: contestId,
      title: `客观题竞赛2 ${ts}`,
      description: "",
      start_time: new Date(Date.now() - 3600_000).toISOString(),
      end_time: new Date(Date.now() + 3600_000).toISOString(),
      type: "icpc",
      config: {},
      created_at: now,
      updated_at: now,
    });

    // 未注册
    await assertRejects(
      () =>
        submitObjectivePaper(paper, {
          answers: { [q1]: ["A"] },
          contest_id: contestId,
        }, user),
      ForbiddenError,
    );

    // 已注册但套卷不在题单
    await db.insert(contestParticipants).values({
      contest_id: contestId,
      user_id: user,
      registered_at: now,
    });
    await assertRejects(
      () =>
        submitObjectivePaper(paper, {
          answers: { [q1]: ["A"] },
          contest_id: contestId,
        }, user),
      BadRequestError,
    );

    // 套卷在题单但竞赛未开始
    await db.insert(contestProblems).values({
      contest_id: contestId,
      problem_id: paper,
      sort_order: 1,
      label: "A",
    });
    await db.update(contests).set({
      start_time: new Date(Date.now() + 3600_000).toISOString(),
      end_time: new Date(Date.now() + 7200_000).toISOString(),
    }).where(eq(contests.id, contestId));
    await assertRejects(
      () =>
        submitObjectivePaper(paper, {
          answers: { [q1]: ["A"] },
          contest_id: contestId,
        }, stranger),
      ForbiddenError,
    );
  },
});

Deno.test({
  name: "objective submissions: 提交详情权限（他人 403）与解析合并",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const owner = await makeUser("owner");
    const user = await makeUser("author");
    const other = await makeUser("other");
    const paper = await makePaper(owner);
    const q1 = await makeQuestion(paper, 1, "single", ["A"], "解析");

    const result = await submitObjectivePaper(paper, {
      answers: { [q1]: ["A"] },
    }, user);

    // 提交者本人可读（练习模式含解析）
    const mine = await getObjectiveSubmission(result.submission_id, user);
    assertEquals(mine.score, 10000);
    assertEquals(mine.details[q1].explanation, "解析");

    // 他人读取被拒
    await assertRejects(
      () => getObjectiveSubmission(result.submission_id, other),
      ForbiddenError,
    );

    // admin 可读
    const byAdmin = await getObjectiveSubmission(
      result.submission_id,
      "0",
      "admin",
    );
    assertEquals(byAdmin.score, 10000);
  },
});

Deno.test({
  name: "objective submissions: 非 O 型题目提交被拒",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const codeProblem = await makeCodeProblem();
    await assertRejects(
      () =>
        submitObjectivePaper(codeProblem, {
          answers: { x: ["A"] },
        }, "0"),
      BadRequestError,
    );
  },
});
