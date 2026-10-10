/**
 * 竞赛客观题小题固定版本回归（Handbook §6.4，缺陷 #3-contest）。
 *
 * 竞赛页读取套卷小题必须使用**竞赛固定版本**（`contest_problems.pinned_version_id`），
 * 不能被客户端 `version_id` 覆盖，也不能落到题库默认作答版本（`any` → 最新版）。
 * 否则出现"展示最新版小题、按固定版判卷"。
 *
 * 检查点：
 * - 竞赛上下文（`contestId`）→ 固定版本小题 + 回传实际 `version_id`；
 * - 客户端同时传 `version_id=V2` 也不能覆盖竞赛固定版；
 * - 无竞赛上下文 → 题库默认作答版本（any → 最新版）；
 * - 显式 `versionId` → 该版本；
 * - 作答者响应裁剪答案与解析（`answer: []` / `explanation: ""`）。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { eq, inArray } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import {
  contestParticipants,
  contestProblems,
  contests,
  problems,
  problemVersions,
  users,
} from "../../../../shared/db/schema.ts";
import { listPaperQuestionsWithAccess } from "../../../objective/index.ts";

await resetDbForTest({ refreshRankings: true });

const now = new Date().toISOString();
const atMinutes = (minutes: number) =>
  new Date(Date.now() + minutes * 60_000).toISOString();

async function seedUser(prefix: string): Promise<string> {
  const id = crypto.randomUUID();
  const unique = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
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

async function seedPaper(paperId: string, number: number): Promise<void> {
  await getDb().insert(problems).values({
    id: paperId,
    title: "客观题套卷",
    description: "d",
    difficulty: "easy",
    runtime_config: null,
    number,
    owner_id: "0",
    is_objective: true,
    // P 型 + public：用于验证"无竞赛上下文 → 题库默认作答版本"路径
    type: "P",
    visibility: "public",
    created_at: now,
    updated_at: now,
  });
}

function question(sortOrder: number, prompt: string) {
  return {
    key: `q-${sortOrder}`,
    sort_order: sortOrder,
    type: "single" as const,
    prompt,
    options: [{ key: "A", text: "选项 A" }, { key: "B", text: "选项 B" }],
    answer: ["A"],
    explanation: "解析",
  };
}

async function seedVersion(
  paperId: string,
  versionId: string,
  version: number,
  prompt: string,
): Promise<void> {
  await getDb().insert(problemVersions).values({
    id: versionId,
    problem_id: paperId,
    version,
    schema_version: 1,
    origin: "published",
    content: {
      kind: "objective",
      title: "客观题套卷",
      description: "d",
      samples: [],
      questions: [question(version, prompt)],
    } as never,
    content_sha256: `sha-${versionId}`,
    published_at: now,
  });
}

Deno.test({
  name:
    "contest objective(#3): 竞赛小题读固定版本，客户端版本不可覆盖，题库仍读默认作答版本",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const userId = await seedUser("cobj-user");
    const paperId = crypto.randomUUID();
    const contestId = crypto.randomUUID();
    const versionV1 = `${paperId}-v1`;
    const versionV2 = `${paperId}-v2`;

    await seedPaper(paperId, 941301);
    await seedVersion(paperId, versionV1, 1, "V1 小题");
    await seedVersion(paperId, versionV2, 2, "V2 小题");
    await db.update(problems).set({ latest_version_id: versionV2 }).where(
      eq(problems.id, paperId),
    );
    await db.insert(contests).values({
      id: contestId,
      title: "客观题固定版本测试",
      start_time: atMinutes(-30),
      end_time: atMinutes(60),
      type: "kaggle",
      config: {},
      // 邀请赛：不触发"未结束公开赛题目保密"，便于同时验证题库默认作答版本路径
      is_public: false,
      kind: "invite",
      created_by: userId,
      created_at: now,
      updated_at: now,
    });
    await db.insert(contestProblems).values({
      contest_id: contestId,
      problem_id: paperId,
      label: "A",
      sort_order: 0,
      score: 10000,
      pinned_version_id: versionV1,
      effective_version_mode: "any",
      required_version_id: null,
      effective_policy_revision: 0,
    });
    await db.insert(contestParticipants).values({
      contest_id: contestId,
      user_id: userId,
      registered_at: now,
    });

    try {
      // ① 竞赛上下文 → 固定版本 V1
      const inContest = await listPaperQuestionsWithAccess(paperId, {
        viewerId: userId,
        isAdmin: false,
        contestId,
        userId,
      });
      assertEquals(inContest.version_id, versionV1);
      assertEquals(inContest.version, 1);
      assertEquals(inContest.questions.length, 1);
      assertEquals(inContest.questions[0].prompt, "V1 小题");
      // 作答者响应必须裁剪答案与解析（响应字段不下发，而非置空数组）
      assertEquals(inContest.questions[0].answer, undefined);
      assertEquals(inContest.questions[0].explanation, undefined);

      // ② 客户端传 version_id=V2 也不能覆盖竞赛固定版本
      const override = await listPaperQuestionsWithAccess(paperId, {
        viewerId: userId,
        isAdmin: false,
        contestId,
        versionId: versionV2,
        userId,
      });
      assertEquals(override.version_id, versionV1);
      assertEquals(override.questions[0].prompt, "V1 小题");

      // ③ 无竞赛上下文 → 题库默认作答版本（any → 最新版 V2）
      const practice = await listPaperQuestionsWithAccess(paperId, {
        viewerId: userId,
        isAdmin: false,
      });
      assertEquals(practice.version_id, versionV2);
      assertEquals(practice.questions[0].prompt, "V2 小题");

      // ④ 显式 versionId → 该版本
      const explicit = await listPaperQuestionsWithAccess(paperId, {
        viewerId: userId,
        isAdmin: false,
        versionId: versionV1,
      });
      assertEquals(explicit.version_id, versionV1);
      assertEquals(explicit.questions[0].prompt, "V1 小题");

      // ⑤ 固定版本升级为 V2 后，竞赛小题随固定版本变化
      await db.update(contestProblems).set({ pinned_version_id: versionV2 })
        .where(eq(contestProblems.contest_id, contestId));
      const upgraded = await listPaperQuestionsWithAccess(paperId, {
        viewerId: userId,
        isAdmin: false,
        contestId,
        userId,
      });
      assertEquals(upgraded.version_id, versionV2);
      assertEquals(upgraded.questions[0].prompt, "V2 小题");
    } finally {
      await db.delete(contestParticipants).where(
        eq(contestParticipants.contest_id, contestId),
      );
      await db.delete(contestProblems).where(
        eq(contestProblems.contest_id, contestId),
      );
      await db.delete(contests).where(eq(contests.id, contestId));
      await db.update(problems).set({ latest_version_id: null }).where(
        eq(problems.id, paperId),
      );
      await db.delete(problemVersions).where(
        eq(problemVersions.problem_id, paperId),
      );
      await db.delete(problems).where(eq(problems.id, paperId));
      await db.delete(users).where(inArray(users.id, [userId]));
    }
  },
});
