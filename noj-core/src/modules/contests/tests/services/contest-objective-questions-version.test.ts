import { deleteProblemFixtures } from "../../../../../tests/helper.ts";
import { contestProblemExecutionForTest } from "../../../../../tests/helper.ts";
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
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { ForbiddenError } from "../../../../shared/base/errors.ts";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import { resetDbForTest } from "../../../../../tests/helpers/db.ts";
import {
  contestParticipants,
  contestProblems,
  contests,
  domainMemberRoles,
  domainProblemBindings,
  problems,
  problemVersions,
  users,
} from "../../../../shared/db/schema.ts";
import { listPaperQuestionsWithAccess } from "../../../problems/index.ts";
import {
  addDomainMember,
  DEFAULT_DOMAIN_ID,
  ensureDefaultWorkspace,
} from "../../../access/workspace/index.ts";
import { generatePublicId } from "../../../../shared/security/public-id.ts";

await resetDbForTest({ refreshRankings: true });
await ensureDefaultWorkspace();

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
  const member = await addDomainMember(getDb(), DEFAULT_DOMAIN_ID, id);
  await getDb().insert(domainMemberRoles).values({
    membership_id: member.id,
    role: "editor",
  });
  return id;
}

async function seedPaper(paperId: string, number: number): Promise<void> {
  await getDb().insert(problems).values({
    id: paperId,
    domain_id: "00000000-0000-4000-8000-000000000001",
    title: "客观题套卷",
    description: "d",
    difficulty: "easy",
    runtime_config: null,
    number,
    owner_id: "0",
    is_objective: true,
    // P 型 + public：用于验证"无竞赛上下文 → 题库默认作答版本"路径
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
    const contestPublicId = generatePublicId("ct");
    const versionV1 = `${paperId}-v1`;
    const versionV2 = `${paperId}-v2`;

    await seedPaper(paperId, 941301);
    await seedVersion(paperId, versionV1, 1, "V1 小题");
    await seedVersion(paperId, versionV2, 2, "V2 小题");
    await db.update(problems).set({ latest_version_id: versionV2 }).where(
      eq(problems.id, paperId),
    );
    await db.insert(domainProblemBindings).values({
      id: `${paperId}-binding`,
      domain_id: DEFAULT_DOMAIN_ID,
      problem_id: paperId,
      kind: "owned",
      visibility: "public",
      created_by: "0",
      created_at: now,
      updated_at: now,
    });
    await db.insert(contests).values({
      domain_id: DEFAULT_DOMAIN_ID,
      id: contestId,
      public_id: contestPublicId,
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
      ...await contestProblemExecutionForTest(contestId, paperId),
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

      // 浏览器 URL 携带 public_id 时也必须显示固定 V1，不能回退题库最新版 V2。
      const viaPublicId = await listPaperQuestionsWithAccess(paperId, {
        viewerId: userId,
        isAdmin: false,
        contestId: contestPublicId,
        userId,
        versionId: versionV2,
      });
      assertEquals(viaPublicId.version_id, versionV1);
      assertEquals(viaPublicId.questions, inContest.questions);

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

      // 普通入口及显式历史版本都受保护，不能借版本参数绕过竞赛上下文。
      await assertRejects(() =>
        listPaperQuestionsWithAccess(paperId, {
          viewerId: userId,
          isAdmin: false,
        }), ForbiddenError);

      // ④ 显式 versionId → 该版本
      await assertRejects(() =>
        listPaperQuestionsWithAccess(paperId, {
          viewerId: userId,
          isAdmin: false,
          versionId: versionV1,
        }), ForbiddenError);

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
      await db.delete(domainProblemBindings).where(
        eq(domainProblemBindings.problem_id, paperId),
      );
      await db.update(problems).set({ latest_version_id: null }).where(
        eq(problems.id, paperId),
      );
      await db.delete(problemVersions).where(
        eq(problemVersions.problem_id, paperId),
      );
      await deleteProblemFixtures(eq(problems.id, paperId));
      await db.update(users).set({ deleted_at: now }).where(
        inArray(users.id, [userId]),
      );
    }
  },
});
