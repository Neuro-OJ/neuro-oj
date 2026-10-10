/**
 * 提交读路径的版本信息测试（Handbook §2.7、§4.4）。
 *
 * 覆盖：
 * - 详情返回提交时版本（ID/版本号/来源）与「各版本当前判定」（跨版本保留）；
 * - 有效成绩指针与通过指针分别独立选择，且随题目有效版本策略切换而改变；
 * - 迁移期 `legacy_unknown` 提交：版本 ID/版本号为空，未知版本桶判定照常返回；
 * - 列表项同样携带提交时版本（供"按版本筛选/展示"使用）。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import {
  evaluationAttempts,
  problems,
  problemVersions,
  submissions,
} from "../../../../shared/db/schema.ts";
import type { ProjectionSource } from "../../services/versioning/projection.ts";
import { upsertCurrentVersionResult } from "../../services/versioning/projection.ts";
import { getSubmission, listSubmissions } from "../../index.ts";

await resetDbForTest();

const now = new Date().toISOString();

async function seedProblem(
  problemId: string,
  number: number,
): Promise<{ v1: string; v2: string }> {
  const db = getDb();
  await db.insert(problems).values({
    id: problemId,
    title: problemId,
    description: "d",
    type: "P",
    number,
    owner_id: "0",
    difficulty: "easy",
    judge_type: "dual",
    created_at: now,
    updated_at: now,
  });
  await db.insert(problemVersions).values([
    {
      id: `${problemId}-v1`,
      problem_id: problemId,
      version: 1,
      origin: "published",
      content: { kind: "ai", title: problemId },
      published_at: now,
    },
    {
      id: `${problemId}-v2`,
      problem_id: problemId,
      version: 2,
      origin: "published",
      content: { kind: "ai", title: problemId },
      published_at: now,
    },
  ]);
  await db.update(problems).set({ latest_version_id: `${problemId}-v2` })
    .where(eq(problems.id, problemId));
  return { v1: `${problemId}-v1`, v2: `${problemId}-v2` };
}

async function seedSubmission(input: {
  id: string;
  problemId: string;
  versionId: string | null;
}): Promise<ProjectionSource> {
  await getDb().insert(submissions).values({
    id: input.id,
    user_id: "0",
    problem_id: input.problemId,
    language: "python",
    code: "print(1)",
    submitted_version_id: input.versionId,
    version_origin: input.versionId ? "known" : "legacy_unknown",
    created_at: now,
  });
  return {
    kind: "submission",
    id: input.id,
    problem_id: input.problemId,
    contest_id: null,
  };
}

/** 写一条 graded 终态尝试并登记为分版本当前判定。 */
async function seedAttempt(input: {
  attemptId: string;
  source: ProjectionSource;
  problemVersionId: string | null;
  score: number;
  accepted: boolean;
  sequence: number;
}): Promise<void> {
  const db = getDb();
  await db.insert(evaluationAttempts).values({
    id: input.attemptId,
    submission_id: input.source.id,
    problem_id: input.source.problem_id,
    problem_version_id: input.problemVersionId,
    sequence: input.sequence,
    source: "rejudge",
    state: "finished",
    result_kind: "graded",
    result_status: "finished",
    score: input.score,
    accepted: input.accepted,
    created_at: now,
    finished_at: now,
  });
  await upsertCurrentVersionResult(db, {
    source: input.source,
    problemVersionId: input.problemVersionId,
    attemptId: input.attemptId,
  });
}

Deno.test({
  name: "submission read: 详情与列表返回提交时版本与各版本当前判定",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const { v1, v2 } = await seedProblem("srv-p1", 987001);
    const source = await seedSubmission({
      id: "srv-s1",
      problemId: "srv-p1",
      versionId: v1,
    });
    // V1 得 50 分未通过；V2 得 100 分通过（重测到 V2 后跨版本保留）
    await seedAttempt({
      attemptId: "srv-a1",
      source,
      problemVersionId: v1,
      score: 5000,
      accepted: false,
      sequence: 0,
    });
    await seedAttempt({
      attemptId: "srv-a2",
      source,
      problemVersionId: v2,
      score: 10000,
      accepted: true,
      sequence: 1,
    });

    const detail = await getSubmission("srv-s1", "0");
    assertEquals(detail.submitted_version_id, v1);
    assertEquals(detail.submitted_version, 1);
    assertEquals(detail.version_origin, "known");
    assertEquals(detail.upgraded_from_id, null);
    // 默认 any 策略：最高分 V2 为有效成绩，且它同时是通过指针
    assertEquals(detail.effective_version_policy, { mode: "any" });
    assertEquals(detail.version_results?.length, 2);
    const byVersion = new Map(
      (detail.version_results ?? []).map((item) => [item.version, item]),
    );
    assertEquals(byVersion.get(1)?.score, 5000);
    assertEquals(byVersion.get(1)?.is_effective, false);
    assertEquals(byVersion.get(1)?.is_accepted, false);
    assertEquals(byVersion.get(2)?.score, 10000);
    assertEquals(byVersion.get(2)?.is_effective, true);
    assertEquals(byVersion.get(2)?.is_accepted, true);
    assertEquals(byVersion.get(2)?.status, "finished");
    // 版本判定按尝试序号升序稳定排列
    assertEquals(detail.version_results?.map((item) => item.sequence), [0, 1]);

    // 切换题目策略为 exact(V1)：有效成绩指针改为 V1，通过指针仍指向 V2
    await db.update(problems).set({
      effective_version_mode: "exact",
      required_version_id: v1,
      effective_policy_revision: 1,
    }).where(eq(problems.id, "srv-p1"));
    const exact = await getSubmission("srv-s1", "0");
    assertEquals(exact.effective_version_policy, {
      mode: "exact",
      version_id: v1,
    });
    const exactByVersion = new Map(
      (exact.version_results ?? []).map((item) => [item.version, item]),
    );
    assertEquals(exactByVersion.get(1)?.is_effective, true);
    assertEquals(exactByVersion.get(1)?.is_accepted, false);
    // 通过指针同样只在策略接受的版本内选择：exact(V1) 下 V2 的通过不构成
    // "当前通过要求已满足"（判定本身仍保留在列表中，只是不是指针）
    assertEquals(exactByVersion.get(2)?.is_effective, false);
    assertEquals(exactByVersion.get(2)?.is_accepted, false);

    // 列表项同样携带提交时版本
    const list = await listSubmissions({
      userId: "0",
      problemId: "srv-p1",
      page: 1,
      perPage: 10,
    });
    assertEquals(list.data.length, 1);
    assertEquals(list.data[0].submitted_version_id, v1);
    assertEquals(list.data[0].submitted_version, 1);
    assertEquals(list.data[0].version_origin, "known");
  },
});

Deno.test({
  name: "submission read: legacy_unknown 提交版本为空但仍有未知版本桶判定",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { v1 } = await seedProblem("srv-p2", 987002);
    const source = await seedSubmission({
      id: "srv-s2",
      problemId: "srv-p2",
      versionId: null,
    });
    // 迁移导入的历史判定：未知版本桶（problem_version_id 为空），any 策略下计入候选
    await seedAttempt({
      attemptId: "srv-a3",
      source,
      problemVersionId: null,
      score: 7000,
      accepted: false,
      sequence: 0,
    });

    const detail = await getSubmission("srv-s2", "0");
    assertEquals(detail.submitted_version_id, null);
    assertEquals(detail.submitted_version, null);
    assertEquals(detail.version_origin, "legacy_unknown");
    assertEquals(detail.version_results?.length, 1);
    assertEquals(detail.version_results?.[0].problem_version_id, null);
    assertEquals(detail.version_results?.[0].version, null);
    assertEquals(detail.version_results?.[0].is_effective, true);

    // 列表项：未知版本提交的版本号为 null，来源仍如实标注
    const list = await listSubmissions({
      userId: "0",
      problemId: "srv-p2",
      page: 1,
      perPage: 10,
    });
    assertEquals(list.data[0].submitted_version_id, null);
    assertEquals(list.data[0].submitted_version, null);
    assertEquals(list.data[0].version_origin, "legacy_unknown");

    // 收紧为 exact(V1) 后，未知版本桶不再计入候选：无有效成绩
    await getDb().update(problems).set({
      effective_version_mode: "exact",
      required_version_id: v1,
      effective_policy_revision: 1,
    }).where(eq(problems.id, "srv-p2"));
    const exact = await getSubmission("srv-s2", "0");
    assertEquals(exact.version_results?.[0].is_effective, false);
  },
});
