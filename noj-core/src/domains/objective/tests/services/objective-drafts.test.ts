/**
 * 客观题小题草稿与版本快照测试（Handbook §6.4）。
 *
 * 覆盖：key 稳定（编辑保留、新增生成 UUID）、增删小题、整卷替换必须显式 key、
 * 发布后快照冻结（草稿继续编辑不影响历史版本）、答案与选项校验。
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import { problems } from "../../../../shared/db/schema.ts";
import {
  createDraftQuestion,
  deleteDraftQuestion,
  listDraftQuestions,
  listVersionQuestions,
  replaceDraftQuestions,
  updateDraftQuestion,
} from "../../services/versioning/objective-drafts.ts";
import {
  type ProblemDraftContent,
  publishProblemVersion,
  saveProblemDraft,
} from "../../../catalog/index.ts";

const now = new Date().toISOString();

async function seedPaper(id: string, number: number): Promise<void> {
  await getDb().insert(problems).values({
    id,
    title: "客观题套卷",
    description: "d",
    type: "P",
    number,
    owner_id: "0",
    difficulty: "easy",
    judge_type: "dual",
    is_objective: true,
    created_at: now,
    updated_at: now,
  });
}

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

Deno.test("objective draft: 新增小题生成 UUID key 并递增 revision", async () => {
  await seedPaper("od-p1", 970001);
  const created = await createDraftQuestion(
    "od-p1",
    singleQuestion("题干1"),
    0,
    "0",
  );
  assertEquals(created.key.length > 0, true);
  assertEquals(created.type, "single");
  assertEquals(created.answer, ["A"]);

  const draft = await listDraftQuestions("od-p1");
  assertEquals(draft.length, 1);
  assertEquals(draft[0].key, created.key);

  // 再次新增（revision 已为 1，需要传 1）
  const second = await createDraftQuestion(
    "od-p1",
    singleQuestion("题干2"),
    1,
    "0",
  );
  assertEquals(second.key !== created.key, true);
  assertEquals((await listDraftQuestions("od-p1")).length, 2);
});

Deno.test("objective draft: 编辑保留 key，删除按 key", async () => {
  await seedPaper("od-p2", 970002);
  const q1 = await createDraftQuestion("od-p2", singleQuestion("原始题干"), 0);
  const updated = await updateDraftQuestion(
    "od-p2",
    q1.key,
    { prompt: "改后题干", sort_order: 5 },
    1,
  );
  assertEquals(updated.key, q1.key);
  assertEquals(updated.prompt, "改后题干");
  assertEquals(updated.sort_order, 5);

  const q2 = await createDraftQuestion("od-p2", singleQuestion("另一题"), 2);
  await deleteDraftQuestion("od-p2", q2.key, 3);
  const remaining = await listDraftQuestions("od-p2");
  assertEquals(remaining.map((question) => question.key), [q1.key]);

  await assertRejects(() => deleteDraftQuestion("od-p2", "no-such-key", 4));
});

Deno.test("objective draft: 答案必须存在于选项、题型校验", async () => {
  await seedPaper("od-p3", 970003);
  await assertRejects(() =>
    createDraftQuestion(
      "od-p3",
      { ...singleQuestion("x", "Z") },
      0,
    )
  );
  await assertRejects(() =>
    createDraftQuestion(
      "od-p3",
      {
        type: "multiple",
        prompt: "x",
        options: [{ key: "A", text: "a" }],
        answer: [],
      },
      0,
    )
  );
  await assertRejects(() =>
    createDraftQuestion(
      "od-p3",
      { ...singleQuestion("x"), type: "unknown" },
      0,
    )
  );
  // 判断题使用固定对/错选项
  const judge = await createDraftQuestion(
    "od-p3",
    { type: "judge", prompt: "对错题", answer: [true] },
    0,
  );
  assertEquals(judge.options.map((option) => option.key), ["true", "false"]);
});

Deno.test("objective draft: 整卷替换必须显式携带 key 且不重复", async () => {
  await seedPaper("od-p4", 970004);
  const base = (key: string, prompt: string) => ({
    key,
    sort_order: 0,
    type: "single" as const,
    prompt,
    options: [{ key: "A", text: "a" }],
    answer: ["A"],
    explanation: "",
  });
  await assertRejects(() =>
    replaceDraftQuestions(
      "od-p4",
      [{ ...base("k1", "p"), key: "" }],
      0,
    )
  );
  await assertRejects(() =>
    replaceDraftQuestions("od-p4", [base("k1", "p"), base("k1", "q")], 0)
  );
  const saved = await replaceDraftQuestions(
    "od-p4",
    [base("k1", "p"), base("k2", "q")],
    0,
  );
  assertEquals(saved.map((question) => question.key), ["k1", "k2"]);
});

Deno.test("objective draft: 发布后快照冻结，草稿继续编辑不影响历史版本", async () => {
  await seedPaper("od-p5", 970005);
  const q1 = await createDraftQuestion("od-p5", singleQuestion("V1 第一题"), 0);
  const q2 = await createDraftQuestion("od-p5", singleQuestion("V1 第二题"), 1);

  // 发布需要完整内容：题面 + 样例 + 小题（草稿内容已由 createDraftQuestion 维护）
  await saveProblemDraft("od-p5", {
    content: {
      ...(await draftContent("od-p5")),
      title: "客观题套卷",
      description: "题面",
      samples: [],
    },
    expectedRevision: 2,
  });
  const published = await publishProblemVersion("od-p5", {
    expectedRevision: 3,
    changeNote: "V1",
  });
  assertEquals(published.version, 1);

  // 版本快照包含两题
  const v1Questions = await listVersionQuestions(published.version_id);
  assertEquals(v1Questions.map((question) => question.key), [q1.key, q2.key]);

  // 草稿继续编辑：改题干 + 加第三题
  await updateDraftQuestion("od-p5", q1.key, { prompt: "V2 改过的第一题" }, 4);
  await createDraftQuestion("od-p5", singleQuestion("V2 新增第三题"), 5);

  // 历史版本不受影响
  const stillV1 = await listVersionQuestions(published.version_id);
  assertEquals(stillV1.length, 2);
  assertEquals(stillV1[0].prompt, "V1 第一题");

  // 草稿是新内容
  const draft = await listDraftQuestions("od-p5");
  assertEquals(draft.length, 3);
  assertEquals(draft.some((question) => question.key === q1.key), true);
  assertEquals(
    draft.find((question) => question.key === q1.key)?.prompt,
    "V2 改过的第一题",
  );
});

/** 读取草稿内容（用于构造完整发布内容）。 */
async function draftContent(problemId: string): Promise<ProblemDraftContent> {
  const { getProblemDraft } = await import("../../../catalog/index.ts");
  const draft = await getProblemDraft(problemId);
  return draft.content;
}

Deno.test("objective draft: 题目投影与旧小题表不被草稿写入触碰", async () => {
  await seedPaper("od-p6", 970006);
  const before = await getDb().select().from(problems).where(
    eq(problems.id, "od-p6"),
  );
  await createDraftQuestion("od-p6", singleQuestion("仅草稿"), 0);
  const after = await getDb().select().from(problems).where(
    eq(problems.id, "od-p6"),
  );
  // 草稿保存不刷新公开题目内容、不改最新版指针
  assertEquals(after[0].latest_version_id, null);
  assertEquals(after[0].updated_at, before[0].updated_at);
});
