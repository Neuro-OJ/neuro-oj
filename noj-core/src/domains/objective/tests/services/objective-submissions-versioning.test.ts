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
  contests,
  evaluationAttempts,
  objectiveSubmissions,
  problems,
  queryProjectionRevisions,
  submissionVersionResults,
  users,
} from "../../../../shared/db/schema.ts";
import { listObjectiveSubmissions, submitObjectivePaper } from "../../index.ts";
import { generatePublicId } from "../../../../shared/security/public-id.ts";
import {
  createDraftQuestion,
  updateDraftQuestion,
} from "../../../../modules/problems/services/objective/versioning/objective-drafts.ts";
import {
  getProblemDraft,
  type ProblemDraftContent,
  publishProblemVersion,
  saveProblemDraft,
} from "../../../../modules/problems/index.ts";
import {
  bindPublishedProblemForTest,
  insertContestProblems,
} from "../../../../../tests/helper.ts";
import { DEFAULT_DOMAIN_ID } from "../../../../shared/workspace/types.ts";

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
  await grantDefaultCatalogRole(ownerId, "editor");
  const id = crypto.randomUUID();
  await db.insert(problems).values({
    domain_id: "00000000-0000-4000-8000-000000000001",
    id,
    title: `版本化客观题卷 ${ts} ${id.slice(0, 6)}`,
    description: "测试套卷",
    difficulty: "easy",
    runtime_config: null,
    number: Math.floor(Math.random() * 90000) + 10000,
    owner_id: ownerId,
    visibility: "public",
    is_objective: true,
    created_at: now,
    updated_at: now,
  });
  await bindPublishedProblemForTest(id);
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

    // 库内提交必须**显式携带版本**（Handbook §4.2 / tracking #6：不再静默绑定最新版）
    let requiredCode: string | undefined;
    try {
      await submitObjectivePaper(paper, {
        answers: { [q1.key]: ["A"], [q2.key]: ["B"] },
      }, user);
    } catch (err) {
      requiredCode = (err as { code?: string }).code;
    }
    assertEquals(requiredCode, "VERSION_REQUIRED");

    // 显式指定 V2：按 V2 判卷——第一题 A 已错，且分母变为 2 题
    const second = await submitObjectivePaper(paper, {
      answers: { [q1.key]: ["A"], [q2.key]: ["B"] },
      version_id: v2.version_id,
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

    // 显式携带的版本逐字生效（不再有"未携带版本 → 绑定最新版"的静默路径）
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
    const contestPublicId = generatePublicId("ct");
    await db.insert(contests).values({
      id: contestId,
      public_id: contestPublicId,
      title: `版本化客观题竞赛 ${ts}`,
      domain_id: DEFAULT_DOMAIN_ID,
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
    await insertContestProblems({
      contest_id: contestId,
      problem_id: paper,
      sort_order: 1,
      label: "A",
      score: 10000,
      pinned_version_id: v1.version_id,
    });

    const result = await submitObjectivePaper(paper, {
      answers: { [q1.key]: ["A"] },
      contest_id: contestPublicId,
      version_id: v1.version_id,
    }, user);
    if (result.contest_mode !== true) throw new Error("竞赛模式应返回赛期回执");

    const [row] = await db.select().from(objectiveSubmissions).where(
      eq(objectiveSubmissions.id, result.submission_id),
    );
    // 竞赛固定版本 → 提交时版本已知
    assertEquals(row.submitted_version_id, v1.version_id);
    assertEquals(row.contest_id, contestId);
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
    const history = await listObjectiveSubmissions({
      viewerId: user,
      viewerRole: "user",
      paperId: paper,
      contestId: contestPublicId,
      page: 1,
      perPage: 20,
    });
    assertEquals(history.total, 1);
    assertEquals(history.data[0].id, result.submission_id);
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
  name:
    "objective versioning: 未发布套卷/未携带版本拒绝新提交（不再静默 legacy_unknown）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const owner = await makeUser("owner");
    const user = await makeUser("legacy");
    const paper = await makePaper(owner);
    // 只写草稿、不发布版本：模拟尚未版本化的存量套卷。
    // `legacy_unknown` 仅供存量迁移，线上提交入口不得再新建（Handbook §4.2、
    // tracking #6）：未发布题目无法按版本提交，必须明确拒绝。
    await createDraftQuestion(
      paper,
      singleQuestion("存量题"),
      await rev(paper),
    );

    let code: string | undefined;
    try {
      await submitObjectivePaper(paper, { answers: {} }, user);
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    assertEquals(code, "VERSION_REQUIRED");
    // 未产生任何提交记录
    const rows = await db.select().from(objectiveSubmissions).where(
      eq(objectiveSubmissions.paper_id, paper),
    );
    assertEquals(rows.length, 0);
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

/**
 * 读路径字段（tracking #53）：详情/列表必须下发提交时版本、有效性指针与逐次尝试，
 * 命名与普通提交侧一致；竞赛未结束时通过与否必须屏蔽（防答案预言机）。
 */
Deno.test({
  name: "objective versioning: 详情下发版本/有效性/尝试指针字段",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const owner = await makeUser("owner");
    const user = await makeUser("readmeta");
    const paper = await makePaper(owner);
    const q1 = await createDraftQuestion(
      paper,
      singleQuestion("第一题"),
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

    // 发布 V2：提交时版本不再是该题最新版（is_latest 必须为 false）
    await saveProblemDraft(paper, {
      content: { ...(await draftContent(paper)), title: "V2 题面" },
      expectedRevision: await rev(paper),
    });
    const v2 = await publishProblemVersion(paper, {
      expectedRevision: await rev(paper),
      changeNote: "V2",
    });

    const { getObjectiveSubmission, listObjectiveSubmissions } = await import(
      "../../index.ts"
    );
    const detail = await getObjectiveSubmission(result.submission_id, user);
    assertEquals(detail.submitted_version_id, v1.version_id);
    assertEquals(detail.submitted_version, 1);
    assertEquals(detail.version_origin, "known");
    assertEquals(detail.is_latest, false);
    assertEquals(detail.is_valid, true);
    assertEquals(detail.is_accepted, true);
    assertEquals(detail.effective_attempt_id !== null, true);
    assertEquals(detail.accepted_attempt_id !== null, true);
    assertEquals(detail.active_attempt_id, null);
    assertEquals(detail.latest_attempt_id !== null, true);
    assertEquals(detail.attempts.length, 1);
    assertEquals(detail.attempts[0].source, "initial");
    assertEquals(detail.attempts[0].state, "finished");
    assertEquals(detail.attempts[0].result_kind, "graded");
    assertEquals(detail.attempts[0].version, 1);
    assertEquals(detail.attempts[0].is_effective, true);
    assertEquals(detail.attempts[0].is_accepted, true);
    assertEquals(detail.attempts[0].is_latest, true);
    assertEquals(
      detail.latest_attempt?.attempt_id,
      detail.attempts[0].attempt_id,
    );
    assertEquals(
      detail.effective_attempt?.attempt_id,
      detail.effective_attempt_id,
    );
    assertEquals(
      detail.effective_attempt_id,
      detail.accepted_attempt_id,
      "满分判定应同时是有效指针与通过指针",
    );

    // 列表路径字段一致（批量加载不得丢字段或错标 is_latest）
    const list = await listObjectiveSubmissions({
      viewerId: user,
      paperId: paper,
      page: 1,
      perPage: 10,
    });
    const item = list.data.find((row) => row.id === result.submission_id)!;
    assertEquals(item.submitted_version_id, v1.version_id);
    assertEquals(item.submitted_version, 1);
    assertEquals(item.is_latest, false);
    assertEquals(item.is_valid, true);
    assertEquals(item.is_accepted, true);
    assertEquals(item.attempts.length, 1);
    assertEquals(item.attempts[0].is_latest, true);
    // 发布 V2 后，V2 才是最新版；上面断言基于"提交 V1"这一事实
    assertEquals(v2.version, 2);
  },
});

Deno.test({
  name: "objective versioning: 平台错误尝试保留历史但不改写有效判定",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const owner = await makeUser("owner");
    const user = await makeUser("platformerr");
    const paper = await makePaper(owner);
    const q1 = await createDraftQuestion(
      paper,
      singleQuestion("第一题"),
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

    // 追加一次平台错误尝试（判卷服务异常）：不得替换已有正式判定
    const errAttemptId = crypto.randomUUID();
    await db.insert(evaluationAttempts).values({
      id: errAttemptId,
      objective_submission_id: result.submission_id,
      problem_id: paper,
      problem_version_id: v1.version_id,
      sequence: 1,
      source: "rejudge",
      state: "error",
      result_kind: "platform_error",
      result_status: "SystemError",
      score: null,
      accepted: false,
      created_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
    });
    await db.update(objectiveSubmissions).set({
      latest_attempt_id: errAttemptId,
      active_attempt_id: null,
    }).where(eq(objectiveSubmissions.id, result.submission_id));

    const { getObjectiveSubmission } = await import("../../index.ts");
    const detail = await getObjectiveSubmission(result.submission_id, user);
    assertEquals(detail.attempts.length, 2);
    const platformError = detail.attempts.find((a) =>
      a.attempt_id === errAttemptId
    )!;
    assertEquals(platformError.result_kind, "platform_error");
    assertEquals(platformError.state, "error");
    assertEquals(platformError.status, "error");
    assertEquals(platformError.is_latest, true);
    assertEquals(platformError.is_effective, false);
    // 已有正式判定与通过标记保持不变
    assertEquals(detail.is_valid, true);
    assertEquals(detail.is_accepted, true);
    assertEquals(detail.effective_attempt_id !== errAttemptId, true);
    assertEquals(detail.accepted_attempt_id !== errAttemptId, true);
    assertEquals(detail.latest_attempt_id, errAttemptId);
  },
});

Deno.test({
  name: "objective versioning: 升级派生提交下发 upgraded_from_id",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const owner = await makeUser("owner");
    const user = await makeUser("upgraded");
    const paper = await makePaper(owner);
    const q1 = await createDraftQuestion(
      paper,
      singleQuestion("第一题"),
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

    // 升级生成的新提交：指向来源提交
    const derivedId = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    await db.insert(objectiveSubmissions).values({
      domain_id: DEFAULT_DOMAIN_ID,
      domain_problem_binding_id: await bindPublishedProblemForTest(paper),
      id: derivedId,
      paper_id: paper,
      user_id: user,
      submission_type: "practice",
      answers: { [q1.key]: ["A"] },
      status: "finished",
      score: 10000,
      details: {},
      submitted_version_id: v1.version_id,
      version_origin: "known",
      upgraded_from_id: result.submission_id,
      is_valid: true,
      is_accepted: true,
      created_at: nowIso,
    });

    const { getObjectiveSubmission } = await import("../../index.ts");
    const derived = await getObjectiveSubmission(derivedId, user);
    assertEquals(derived.upgraded_from_id, result.submission_id);
    assertEquals(derived.submitted_version_id, v1.version_id);
    assertEquals(derived.is_latest, true);
    const source = await getObjectiveSubmission(result.submission_id, user);
    assertEquals(source.upgraded_from_id, null);
  },
});

Deno.test({
  name: "objective versioning: 竞赛未结束时详情屏蔽通过标记（防答案预言机）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const owner = await makeUser("owner");
    const user = await makeUser("oracle");
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
      title: `防预言机竞赛 ${ts}`,
      domain_id: DEFAULT_DOMAIN_ID,
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
    await insertContestProblems({
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
      version_id: v1.version_id,
    }, user);
    if (result.contest_mode !== true) throw new Error("竞赛模式应返回赛期回执");

    const { getObjectiveSubmission } = await import("../../index.ts");
    const detail = await getObjectiveSubmission(result.submission_id, user);
    // 分数、逐题对错与"是否通过"在赛期一律不可见
    assertEquals(detail.score, 10000);
    assertEquals(detail.is_accepted, null);
    assertEquals(detail.accepted_attempt_id, null);
    assertEquals(detail.effective_attempt, null);
    assertEquals(detail.attempts.length, 1);
    assertEquals(detail.attempts[0].is_accepted, false);
    assertEquals(detail.attempts[0].is_effective, false);
    // 版本信息不泄题：照常下发
    assertEquals(detail.submitted_version_id, v1.version_id);
    assertEquals(detail.submitted_version, 1);
    assertEquals(detail.version_origin, "known");
    assertEquals(detail.is_latest, true);
  },
});

import { resetDbForTest } from "../../../../modules/problems/tests/default-fixture.ts";

await resetDbForTest();

import { grantDefaultCatalogRole } from "../../../../modules/problems/tests/default-fixture.ts";
