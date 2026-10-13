/**
 * 客观题小题读取的**作答版本绑定**测试（Handbook §2.6/§6.4，tracking #3）。
 *
 * 展示的小题必须与判卷使用的版本一致：
 * - 竞赛 → 该竞赛**固定版本**（不能被最新版或客户端参数覆盖）；
 * - 题库显式 `version_id` → 该版本；
 * - 缺省 → 默认作答版本（`exact` → 要求版本、`any` → 最新版）。
 * 否则会出现"展示 V2 小题、按 V1 判卷"。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  contestParticipants,
  contests,
  problems,
  users,
} from "../../../../shared/db/schema.ts";
import {
  createDraftQuestion,
  listPaperQuestionsWithAccess,
} from "../../index.ts";
import {
  getProblemDraft,
  type ProblemDraftContent,
  publishProblemVersion,
  saveProblemDraft,
} from "../../../catalog/index.ts";
import { insertContestProblems } from "../../../../../tests/helper.ts";

const db = getDb();
const now = new Date().toISOString();
const ts = Date.now();

async function makeUser(tag: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(users).values({
    id,
    username: `objq-${tag}-${ts}-${id.slice(0, 6)}`,
    email: `objq-${tag}-${ts}-${id.slice(0, 6)}@test.local`,
    password_hash: "hash",
    created_at: now,
    updated_at: now,
  });
  return id;
}

async function makePaper(ownerId: string): Promise<string> {
  await grantDefaultCatalogRole(ownerId, "editor");
  const id = crypto.randomUUID();
  await db.insert(problems).values({
    domain_id: "00000000-0000-4000-8000-000000000001",
    id,
    title: `小题目版本绑定 ${ts} ${id.slice(0, 6)}`,
    description: "套卷",
    difficulty: "easy",
    runtime_config: null,
    number: Math.floor(Math.random() * 90000) + 10000,
    owner_id: ownerId,
    visibility: "public",
    is_objective: true,
    created_at: now,
    updated_at: now,
  });
  return id;
}

async function rev(problemId: string): Promise<number> {
  return (await getProblemDraft(problemId)).revision;
}

async function draftContent(problemId: string): Promise<ProblemDraftContent> {
  return (await getProblemDraft(problemId)).content;
}

function single(prompt: string, answer = "A") {
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

/** 发布当前草稿（补齐题面字段）。 */
async function publish(
  problemId: string,
  note: string,
): Promise<{ version_id: string; version: number }> {
  const revision = await rev(problemId);
  await saveProblemDraft(problemId, {
    content: {
      ...(await draftContent(problemId)),
      title: "小题目版本绑定",
      description: "题面",
      samples: [],
    },
    expectedRevision: revision,
  });
  return await publishProblemVersion(problemId, {
    expectedRevision: revision + 1,
    changeNote: note,
  });
}

Deno.test("objective questions: 题库显式版本读取该版本小题（不受最新版影响）", async () => {
  const owner = await makeUser("owner");
  const viewer = await makeUser("viewer");
  const paper = await makePaper(owner);

  const q1 = await createDraftQuestion(
    paper,
    single("V1 第一题"),
    await rev(paper),
  );
  const v1 = await publish(paper, "V1");

  // V2：删掉 V1 小题、换成另一题（小题集合不同，便于区分展示来源）
  const draft = await draftContent(paper);
  await saveProblemDraft(paper, {
    content: {
      ...draft,
      title: "小题目版本绑定",
      description: "题面",
      samples: [],
      questions: [],
    } as unknown as ProblemDraftContent,
    expectedRevision: await rev(paper),
  });
  const q2 = await createDraftQuestion(
    paper,
    single("V2 第一题"),
    await rev(paper),
  );
  const v2 = await publish(paper, "V2");
  assertEquals(v2.version, 2);

  // 缺省 → 默认作答版本（any → 最新版 V2）
  const defaultRead = await listPaperQuestionsWithAccess(paper, {
    viewerId: viewer,
    isAdmin: false,
  });
  assertEquals(defaultRead.version_id, v2.version_id);
  assertEquals(
    defaultRead.questions.map((q) => q.id),
    [q2.key],
  );

  // 显式 V1 → 必须给 V1 的小题
  const asV1 = await listPaperQuestionsWithAccess(paper, {
    viewerId: viewer,
    isAdmin: false,
    versionId: v1.version_id,
  });
  assertEquals(asV1.version_id, v1.version_id);
  assertEquals(asV1.questions.map((q) => q.id), [q1.key]);
});

Deno.test("objective questions: 竞赛读取固定版本小题（不被最新版覆盖）", async () => {
  const owner = await makeUser("owner");
  const viewer = await makeUser("contestant");
  await grantDefaultCatalogRole(viewer, "member");
  const paper = await makePaper(owner);

  const q1 = await createDraftQuestion(
    paper,
    single("竞赛 V1 题"),
    await rev(paper),
  );
  const v1 = await publish(paper, "V1");

  const draft = await draftContent(paper);
  await saveProblemDraft(paper, {
    content: {
      ...draft,
      title: "小题目版本绑定",
      description: "题面",
      samples: [],
      questions: [],
    } as unknown as ProblemDraftContent,
    expectedRevision: await rev(paper),
  });
  await createDraftQuestion(
    paper,
    single("竞赛 V2 题"),
    await rev(paper),
  );
  const v2 = await publish(paper, "V2");
  assertEquals(v2.version, 2);

  const contestId = crypto.randomUUID();
  await db.insert(contests).values({
    id: contestId,
    title: `小题目版本竞赛 ${ts}`,
    created_by: "0",
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
    user_id: viewer,
    registered_at: now,
  });
  // 竞赛固定 V1（最新版已是 V2）
  await insertContestProblems({
    contest_id: contestId,
    problem_id: paper,
    sort_order: 1,
    label: "A",
    score: 10000,
    pinned_version_id: v1.version_id,
  });

  // 竞赛上下文：即使客户端传 V2 也必须回答**固定版本 V1**
  const contestRead = await listPaperQuestionsWithAccess(paper, {
    viewerId: viewer,
    isAdmin: false,
    contestId,
    versionId: v2.version_id,
  });
  assertEquals(contestRead.version_id, v1.version_id);
  assertEquals(contestRead.questions.map((q) => q.id), [q1.key]);
  // 源题编辑者身份不能替代比赛组织身份获取答案或新草稿。
  await db.insert(contestParticipants).values({
    contest_id: contestId,
    user_id: owner,
    registered_at: now,
  });
  const authorAsParticipant = await listPaperQuestionsWithAccess(paper, {
    viewerId: owner,
    userId: owner,
    userRole: "user",
    isAdmin: false,
    contestId,
    versionId: v2.version_id,
  });
  assertEquals(authorAsParticipant.version_id, v1.version_id);
  assertEquals(authorAsParticipant.questions[0].id, q1.key);
  assertEquals(authorAsParticipant.questions[0].answer, undefined);
  assertEquals(authorAsParticipant.questions[0].explanation, undefined);
  const organizerRead = await listPaperQuestionsWithAccess(paper, {
    viewerId: "0",
    userId: "0",
    isAdmin: false,
    contestId,
    versionId: v2.version_id,
  });
  assertEquals(organizerRead.version_id, v1.version_id);
  assertEquals(organizerRead.questions[0].id, q1.key);
  assertEquals(organizerRead.questions[0].answer, ["A"]);
});

Deno.test("objective questions: 显式版本不属于该题返回 404", async () => {
  const owner = await makeUser("owner");
  const viewer = await makeUser("viewer");
  const paper = await makePaper(owner);
  await createDraftQuestion(paper, single("题"), await rev(paper));
  const v1 = await publish(paper, "V1");

  const other = await makePaper(owner);
  await createDraftQuestion(other, single("别卷"), await rev(other));
  const otherV1 = await publish(other, "V1");

  let code: string | undefined;
  try {
    await listPaperQuestionsWithAccess(paper, {
      viewerId: viewer,
      isAdmin: false,
      versionId: otherV1.version_id,
    });
  } catch (err) {
    code = (err as { code?: string }).code;
  }
  assertEquals(code, "PROBLEM_VERSION_NOT_FOUND");
  assertEquals(v1.version, 1);
  assertEquals(
    (await getDb().select({ id: problems.id }).from(problems).where(
      eq(problems.id, paper),
    )).length,
    1,
  );
});

import { resetDbForTest } from "../../../catalog/tests/default-fixture.ts";

await resetDbForTest();

import { grantDefaultCatalogRole } from "../../../catalog/tests/default-fixture.ts";

Deno.test("客观题答案权限：源题作者角色撤销即时裁剪，匿名和伪造 admin 字符串不获取答案", async () => {
  const owner = await makeUser("revoked-editor");
  const paperId = await makePaper(owner);
  const q = await createDraftQuestion(
    paperId,
    single("保留的版本题目"),
    await rev(paperId),
  );
  await publish(paperId, "版本");
  const editorRead = await listPaperQuestionsWithAccess(paperId, {
    viewerId: owner,
    userId: owner,
    isAdmin: false,
  });
  assertEquals(editorRead.questions[0].answer, ["A"]);
  const { domainMemberships, domainMemberRoles } = await import(
    "../../../../shared/db/schema.ts"
  );
  const [membership] = await db.select().from(domainMemberships).where(and(
    eq(domainMemberships.user_id, owner),
    eq(domainMemberships.domain_id, "00000000-0000-4000-8000-000000000001"),
  ));
  await db.delete(domainMemberRoles).where(
    eq(domainMemberRoles.membership_id, membership.id),
  );
  const ordinaryRead = await listPaperQuestionsWithAccess(paperId, {
    viewerId: owner,
    userId: owner,
    userRole: "admin",
    isAdmin: false,
  });
  assertEquals(ordinaryRead.questions[0].id, q.key);
  assertEquals(ordinaryRead.questions[0].answer, undefined);
  const anonymousRead = await listPaperQuestionsWithAccess(paperId, {
    viewerId: null,
    isAdmin: false,
  });
  assertEquals(anonymousRead.questions[0].answer, undefined);
});
