/**
 * 客观题提交的版本化链路测试（Handbook §4.2、§5.4、§6.4）。
 *
 * 覆盖：提交时版本落库（`submitted_version_id` / `version_origin`）、判卷事实源
 * 是提交时版本的小题快照（草稿改动与后续发布都不影响历史）、初次尝试与当前正式
 * 判定在一个事务内写入、有效成绩投影（题库与竞赛双口径）、以及客观题「满分才算
 * 通过」的口径。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  contestParticipants,
  contestProblems,
  contests,
  evaluationAttempts,
  objectiveQuestions,
  objectiveSubmissions,
  problems,
  queryProjectionRevisions,
  submissionVersionResults,
  users,
} from "../../../../shared/db/schema.ts";
import { submitObjectivePaper } from "../../index.ts";
import {
  createDraftQuestion,
  updateDraftQuestion,
} from "../../services/versioning/objective-drafts.ts";
import {
  getProblemDraft,
  type ProblemDraftContent,
  publishProblemVersion,
  saveProblemDraft,
} from "../../../catalog/index.ts";

const db = getDb();
const now = new Date().toISOString();
const ts = Date.now();

/** 创建用户。 */
async function makeUser(tag: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(users).values({
    id,
    username: `objv-${tag}-${ts}-${id.slice(0, 6)}`,
    email: `objv-${tag}-${ts}-${id.slice(0, 6)}@test.local`,
    password_hash: "hash",
    created_at: now,
    updated_at: now,
  });
  return id;
}

/** 创建客观题套卷。 */
async function makePaper(ownerId: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(problems).values({
    id,
    title: `版本化客观题卷 ${ts} ${id.slice(0, 6)}`,
    description: "测试套卷",
    difficulty: "easy",
    runtime_config: null,
    number: Math.floor(Math.random() * 90000) + 10000,
    owner_id: ownerId,
    type: "U",
    visibility: "public",
    is_objective: true,
    created_at: now,
    updated_at: now,
  });
  return id;
}

/** 当前草稿版本号（乐观锁入参）。 */
async function rev(problemId: string): Promise<number> {
  return (await getProblemDraft(problemId)).revision;
}

/** 读取草稿内容（发布入参）。 */
async function draftContent(problemId: string): Promise<ProblemDraftContent> {
  return (await getProblemDraft(problemId)).content;
}

/** 补齐题面并发布当前草稿。 */
async function publishDraft(
  problemId: string,
  changeNote: string,
): Promise<{ version_id: string; version: number }> {
  const revision = await rev(problemId);
  await saveProblemDraft(problemId, {
    content: {
      ...(await draftContent(problemId)),
      title: "版本化客观题卷",
      description: "题面",
      samples: [],
    },
    expectedRevision: revision,
  });
  const published = await publishProblemVersion(problemId, {
    expectedRevision: revision + 1,
    changeNote,
  });
  return { version_id: published.version_id, version: published.version };
}

/** 单选题草稿。 */
function singleQuestion(prompt: string, answer = "A") {
  return {
    type: "single",
    prompt,
    options: [
      { key: "A", text: "选项 A" },
      { key: "B", text: "选项 B" },
    ],
    answer: [answer],
    explanation: "",
  };
}

Deno.test({
  name: "objective versioning: 提交写入版本/尝试/当前判定与有效成绩投影",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const owner = await makeUser("owner");
    const user = await makeUser("full");
    const paper = await makePaper(owner);
    const q1 = await createDraftQuestion(
      paper,
      singleQuestion("第一题"),
      await rev(paper),
    );
    const q2 = await createDraftQuestion(
      paper,
      singleQuestion("第二题", "B"),
      await rev(paper),
    );
    const v1 = await publishDraft(paper, "V1");

    const result = await submitObjectivePaper(paper, {
      answers: { [q1.key]: ["A"], [q2.key]: ["B"] },
      version_id: v1.version_id,
    }, user);
    if (result.contest_mode !== false) {
      throw new Error("练习模式应返回完整判定");
    }
    assertEquals(result.score_db, 10000);

    // ① 提交行：提交时版本不可变且显式记录来源
    const [row] = await db.select().from(objectiveSubmissions).where(
      eq(objectiveSubmissions.id, result.submission_id),
    );
    assertEquals(row.submitted_version_id, v1.version_id);
    assertEquals(row.version_origin, "known");
    assertEquals(row.score, 10000);
    assertEquals(row.status, "finished");

    // ② 初次尝试：source=initial、绑定版本、终态一次性写入
    const attempts = await db.select().from(evaluationAttempts).where(
      eq(evaluationAttempts.objective_submission_id, row.id),
    );
    assertEquals(attempts.length, 1);
    assertEquals(attempts[0].source, "initial");
    assertEquals(attempts[0].sequence, 0);
    assertEquals(attempts[0].problem_version_id, v1.version_id);
    assertEquals(attempts[0].state, "finished");
    assertEquals(attempts[0].result_kind, "graded");
    assertEquals(attempts[0].score, 10000);
    assertEquals(attempts[0].accepted, true);
    assertEquals(row.active_attempt_id, null);
    assertEquals(row.latest_attempt_id, attempts[0].id);

    // ③ 分版本当前正式判定 + 有效成绩投影（客观题满分才算通过）
    const versionResults = await db.select().from(submissionVersionResults)
      .where(eq(submissionVersionResults.objective_submission_id, row.id));
    assertEquals(versionResults.length, 1);
    assertEquals(versionResults[0].problem_version_id, v1.version_id);
    assertEquals(versionResults[0].current_attempt_id, attempts[0].id);

    const [projected] = await db.select().from(objectiveSubmissions).where(
      eq(objectiveSubmissions.id, row.id),
    );
    assertEquals(projected.is_valid, true);
    assertEquals(projected.is_accepted, true);
    assertEquals(projected.effective_attempt_id, attempts[0].id);
    assertEquals(projected.accepted_attempt_id, attempts[0].id);

    // ④ 题目作用域 revision 已递增（成绩变化必须让缓存与物化视图失效）
    const [revision] = await db.select().from(queryProjectionRevisions).where(
      eq(queryProjectionRevisions.scope_key, `problem:${paper}`),
    );
    assertEquals(revision.data_revision >= 1, true);
  },
});

Deno.test({
  name: "objective versioning: 部分正确则有效但未通过（满分口径）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const owner = await makeUser("owner");
    const user = await makeUser("partial");
    const paper = await makePaper(owner);
    const q1 = await createDraftQuestion(
      paper,
      singleQuestion("第一题"),
      await rev(paper),
    );
    const q2 = await createDraftQuestion(
      paper,
      singleQuestion("第二题", "B"),
      await rev(paper),
    );
    const v1 = await publishDraft(paper, "V1");

    const result = await submitObjectivePaper(paper, {
      answers: { [q1.key]: ["A"], [q2.key]: ["A"] },
      version_id: v1.version_id,
    }, user);
    if (result.contest_mode !== false) {
      throw new Error("练习模式应返回完整判定");
    }
    assertEquals(result.score_db, 5000);

    const [row] = await db.select().from(objectiveSubmissions).where(
      eq(objectiveSubmissions.id, result.submission_id),
    );
    // 有正式判定 → is_valid；未满分 → is_accepted=false 且无通过指针
    assertEquals(row.is_valid, true);
    assertEquals(row.is_accepted, false);
    assertEquals(row.effective_attempt_id !== null, true);
    assertEquals(row.accepted_attempt_id, null);
  },
});

Deno.test({
  name: "objective versioning: 判卷用提交时版本快照，发布新版本不影响历史提交",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const owner = await makeUser("owner");
    const user = await makeUser("snapshot");
    const paper = await makePaper(owner);
    const q1 = await createDraftQuestion(
      paper,
      singleQuestion("第一题"),
      await rev(paper),
    );
    const v1 = await publishDraft(paper, "V1");

    // V1 提交：答案为 A → 满分
    const first = await submitObjectivePaper(paper, {
      answers: { [q1.key]: ["A"] },
      version_id: v1.version_id,
    }, user);
    if (first.contest_mode !== false) throw new Error("练习模式应返回完整判定");
    assertEquals(first.score_db, 10000);

    // V2：把第一题答案改成 B 并新增第二题，然后发布
    await updateDraftQuestion(
      paper,
      q1.key,
      { answer: ["B"] },
      await rev(paper),
    );
    const q2 = await createDraftQuestion(
      paper,
      singleQuestion("第二题", "B"),
      await rev(paper),
    );
    const v2 = await publishDraft(paper, "V2");
    assertEquals(v2.version, 2);

    // 库内（policy=any → 默认最新版）提交：按 V2 判卷——第一题 A 已错，
    // 且分母变为 2 题
    const second = await submitObjectivePaper(paper, {
      answers: { [q1.key]: ["A"], [q2.key]: ["B"] },
    }, user);
    if (second.contest_mode !== false) {
      throw new Error("练习模式应返回完整判定");
    }
    assertEquals(second.score_db, 5000);

    // 历史提交的判定与分数不被新版本改写；草稿/新版本都不触碰旧提交
    const [firstRow] = await db.select().from(objectiveSubmissions).where(
      eq(objectiveSubmissions.id, first.submission_id),
    );
    assertEquals(firstRow.submitted_version_id, v1.version_id);
    assertEquals(firstRow.score, 10000);
    assertEquals(firstRow.is_accepted, true);

    // 未携带版本的库内提交绑定当前最新版（any 策略）
    const [secondRow] = await db.select().from(objectiveSubmissions).where(
      eq(objectiveSubmissions.id, second.submission_id),
    );
    assertEquals(secondRow.submitted_version_id, v2.version_id);
  },
});

Deno.test({
  name: "objective versioning: 竞赛提交生效竞赛口径投影",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const owner = await makeUser("owner");
    const user = await makeUser("contestant");
    const paper = await makePaper(owner);
    const q1 = await createDraftQuestion(
      paper,
      singleQuestion("第一题"),
      await rev(paper),
    );
    const v1 = await publishDraft(paper, "V1");

    const contestId = crypto.randomUUID();
    await db.insert(contests).values({
      id: contestId,
      title: `版本化客观题竞赛 ${ts}`,
      description: "",
      start_time: new Date(Date.now() - 3600_000).toISOString(),
      end_time: new Date(Date.now() + 3600_000).toISOString(),
      type: "kaggle",
      config: {},
      created_at: now,
      updated_at: now,
    });
    await db.insert(contestParticipants).values({
      contest_id: contestId,
      user_id: user,
      registered_at: now,
    });
    // 竞赛固定作答版本（effective policy 仍为 any：竞赛口径与题库口径独立）
    await db.insert(contestProblems).values({
      contest_id: contestId,
      problem_id: paper,
      sort_order: 1,
      label: "A",
      score: 10000,
      pinned_version_id: v1.version_id,
    });

    const result = await submitObjectivePaper(paper, {
      answers: { [q1.key]: ["A"] },
      contest_id: contestId,
    }, user);
    if (result.contest_mode !== true) throw new Error("竞赛模式应返回赛期回执");

    const [row] = await db.select().from(objectiveSubmissions).where(
      eq(objectiveSubmissions.id, result.submission_id),
    );
    // 竞赛固定版本 → 提交时版本已知
    assertEquals(row.submitted_version_id, v1.version_id);
    assertEquals(row.version_origin, "known");
    assertEquals(row.is_valid, true);
    assertEquals(row.is_accepted, true);
    // 竞赛口径投影必须与题库口径同时写入（此前 contest_id 丢失导致恒为空）
    assertEquals(row.is_contest_valid, true);
    assertEquals(row.is_contest_accepted, true);
    assertEquals(row.contest_effective_attempt_id !== null, true);
    assertEquals(row.contest_accepted_attempt_id !== null, true);

    const [revision] = await db.select().from(queryProjectionRevisions).where(
      eq(queryProjectionRevisions.scope_key, `contest:${contestId}`),
    );
    assertEquals(revision.data_revision >= 1, true);
  },
});

Deno.test({
  name: "objective versioning: 携带不属于该题的版本被拒（404）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const owner = await makeUser("owner");
    const user = await makeUser("bad-version");
    const paper = await makePaper(owner);
    await createDraftQuestion(
      paper,
      singleQuestion("第一题"),
      await rev(paper),
    );
    await publishDraft(paper, "V1");

    const other = await makePaper(owner);
    const otherQ = await createDraftQuestion(
      other,
      singleQuestion("别卷"),
      await rev(other),
    );
    const otherV1 = await publishDraft(other, "V1");

    let code: string | undefined;
    try {
      await submitObjectivePaper(paper, {
        answers: { [otherQ.key]: ["A"] },
        version_id: otherV1.version_id,
      }, user);
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    assertEquals(code, "PROBLEM_VERSION_NOT_FOUND");
  },
});

Deno.test({
  name: "objective versioning: 存量未版本化套卷回退旧小题表（legacy_unknown）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const owner = await makeUser("owner");
    const user = await makeUser("legacy");
    const paper = await makePaper(owner);
    const q1 = await createDraftQuestion(
      paper,
      singleQuestion("存量题"),
      await rev(paper),
    );
    // 直接写旧小题表（不发布版本），模拟迁移前的存量套卷
    await db.insert(objectiveQuestions).values({
      id: q1.key,
      paper_id: paper,
      sort_order: 0,
      type: "single",
      prompt: "存量题",
      options: [
        { key: "A", text: "选项 A" },
        { key: "B", text: "选项 B" },
      ],
      answer: ["A"],
      explanation: "存量解析",
      created_at: now,
      updated_at: now,
    });

    const result = await submitObjectivePaper(paper, {
      answers: { [q1.key]: ["A"] },
    }, user);
    if (result.contest_mode !== false) {
      throw new Error("练习模式应返回完整判定");
    }
    assertEquals(result.score_db, 10000);
    assertEquals(result.details[q1.key].explanation, "存量解析");

    const [row] = await db.select().from(objectiveSubmissions).where(
      eq(objectiveSubmissions.id, result.submission_id),
    );
    assertEquals(row.submitted_version_id, null);
    assertEquals(row.version_origin, "legacy_unknown");
    // 未知版本桶的判定仍计入 any 策略的候选 → 有效且通过
    assertEquals(row.is_valid, true);
    assertEquals(row.is_accepted, true);
    const versionResults = await db.select().from(submissionVersionResults)
      .where(eq(submissionVersionResults.objective_submission_id, row.id));
    assertEquals(versionResults.length, 1);
    assertEquals(versionResults[0].problem_version_id, null);
  },
});

Deno.test({
  name: "objective versioning: 提交详情按提交时版本还原卷面解析",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const owner = await makeUser("owner");
    const user = await makeUser("detail");
    const paper = await makePaper(owner);
    const q1 = await createDraftQuestion(
      paper,
      { ...singleQuestion("第一题"), explanation: "V1 解析" },
      await rev(paper),
    );
    const v1 = await publishDraft(paper, "V1");

    const result = await submitObjectivePaper(paper, {
      answers: { [q1.key]: ["A"] },
      version_id: v1.version_id,
    }, user);
    if (result.contest_mode !== false) {
      throw new Error("练习模式应返回完整判定");
    }

    // 草稿改解析（未发布）：详情必须仍按 V1 快照给出解析
    await updateDraftQuestion(
      paper,
      q1.key,
      { explanation: "草稿解析" },
      await rev(paper),
    );

    const { getObjectiveSubmission } = await import("../../index.ts");
    const detail = await getObjectiveSubmission(result.submission_id, user);
    assertEquals(detail.details[q1.key].explanation, "V1 解析");
    assertEquals(detail.score, 10000);
  },
});
