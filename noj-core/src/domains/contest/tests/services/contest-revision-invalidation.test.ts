/**
 * 竞赛变更使全站榜口径立即失效（2026-10-11 复审问题 8）。
 *
 * 全站排名的过滤条件包含 `contests.end_time`（赛期结束才计入）与
 * `affect_global_ranking`；这两列被修改、或竞赛被删除（提交的 `contest_id` 置空）
 * 都会改变榜单口径，但**不产生任何提交/判定写入**。因此必须显式递增
 * `query_projection_revisions.global.data_revision`，否则缓存与物化视图会继续按
 * 旧口径命中（08 的边界新鲜度只覆盖"时钟自然跨越 end_time"，覆盖不了"改时间"）。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { eq, inArray } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import {
  contestProblems,
  contests,
  problems,
  problemVersions,
  queryProjectionRevisions,
  users,
} from "../../../../shared/db/schema.ts";
import { deleteContest, updateContest } from "../../index.ts";

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

async function readGlobalRevision(): Promise<number> {
  const rows = await getDb().select({
    data_revision: queryProjectionRevisions.data_revision,
  }).from(queryProjectionRevisions).where(
    eq(queryProjectionRevisions.scope_key, "global"),
  );
  return Number(rows[0]?.data_revision ?? 0);
}

Deno.test({
  name:
    "contest revision(#8): 改 end_time / affect_global_ranking 立即递增 global revision，删竞赛同样",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const adminId = await seedUser("crev-admin");
    const problemId = crypto.randomUUID();
    const contestId = crypto.randomUUID();
    const versionId = `${problemId}-v1`;

    await db.insert(problems).values({
      id: problemId,
      title: "口径失效题",
      description: "d",
      difficulty: "easy",
      runtime_config: null,
      number: 921201,
      owner_id: adminId,
      type: "P",
      created_at: now,
      updated_at: now,
    });
    await db.insert(problemVersions).values({
      id: versionId,
      problem_id: problemId,
      version: 1,
      schema_version: 1,
      origin: "published",
      content: {
        kind: "ai",
        title: "口径失效题",
        description: "d",
        samples: [],
        submission_mode: "code",
        runtime_config: {},
        template_content: "",
        artifact_max_size_mb: null,
        llm_config: null,
      },
      content_sha256: `sha-${versionId}`,
      published_at: now,
    } as never);
    await db.update(problems).set({ latest_version_id: versionId }).where(
      eq(problems.id, problemId),
    );
    await db.insert(contests).values({
      id: contestId,
      title: "口径失效赛",
      start_time: atMinutes(-120),
      end_time: atMinutes(-60),
      type: "kaggle",
      config: {},
      kind: "public",
      is_public: true,
      affect_global_ranking: true,
      created_by: adminId,
      created_at: now,
      updated_at: now,
    });
    await db.insert(contestProblems).values({
      contest_id: contestId,
      problem_id: problemId,
      label: "A",
      sort_order: 0,
      score: 10000,
      pinned_version_id: versionId,
      effective_version_mode: "any",
      required_version_id: null,
      effective_policy_revision: 0,
    });

    try {
      const before = await readGlobalRevision();

      // 改 end_time → 立即失效
      await updateContest(contestId, { end_time: atMinutes(120) }, true);
      const afterEndTime = await readGlobalRevision();
      assertEquals(
        afterEndTime,
        before + 1,
        "改 end_time 必须递增 global revision",
      );

      // 改 affect_global_ranking → 立即失效
      await updateContest(contestId, { affect_global_ranking: false }, true);
      const afterAffect = await readGlobalRevision();
      assertEquals(
        afterAffect,
        afterEndTime + 1,
        "改 affect_global_ranking 必须递增 global revision",
      );

      // 只改标题（不影响榜单口径）→ 不得递增
      await updateContest(contestId, { title: "口径失效赛（改名）" }, true);
      assertEquals(
        await readGlobalRevision(),
        afterAffect,
        "无关字段更新不应递增 revision",
      );

      // 同时改时间与开关 → 只递增一次（同一事务内一次失效）
      await updateContest(contestId, {
        start_time: atMinutes(-30),
        end_time: atMinutes(90),
        affect_global_ranking: true,
      }, true);
      assertEquals(await readGlobalRevision(), afterAffect + 1);

      // 删除竞赛（提交 contest_id 置空）→ 同样递增
      const beforeDelete = await readGlobalRevision();
      await deleteContest(contestId);
      assertEquals(
        await readGlobalRevision(),
        beforeDelete + 1,
        "删除竞赛必须递增 global revision",
      );
    } finally {
      await db.delete(contestProblems).where(
        eq(contestProblems.contest_id, contestId),
      );
      await db.delete(contests).where(eq(contests.id, contestId));
      await db.update(problems).set({ latest_version_id: null }).where(
        eq(problems.id, problemId),
      );
      await db.delete(problemVersions).where(
        eq(problemVersions.problem_id, problemId),
      );
      await db.delete(problems).where(eq(problems.id, problemId));
      await db.delete(users).where(inArray(users.id, [adminId]));
    }
  },
});
