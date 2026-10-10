/**
 * 竞赛提交版本校验路由测试（Handbook §4.2/§4.4）。
 *
 * 覆盖：
 * - 竞赛题目在创建时即固定当时的最新已发布版本，`GET /problems/:label` 下发
 *   `version_id`/`version`；
 * - 客户端携带与固定版本不一致的 `version_id` → 409 `CONTEST_PROBLEM_VERSION_CHANGED`
 *   （不自动改用其他版本）；
 * - 携带一致版本 → 放行（写入 `submitted_version_id`）；
 * - 未携带版本且题目已固定 → 迁移期兼容路径仍用固定版本（不得 409）。
 */
import { assertEquals, assertNotEquals } from "jsr:@std/assert@^1";
import { eq, inArray } from "drizzle-orm";
import { createApp } from "../../../../app.ts";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import {
  contests,
  problems,
  problemVersions,
  submissions,
  userRoles,
  users,
} from "../../../../shared/db/schema.ts";
import { signToken } from "../../../identity/index.ts";
import { initRedisForTest, jsonRequest } from "../../../../../tests/helper.ts";

await resetDbForTest();
await initRedisForTest();

const now = new Date().toISOString();

Deno.test({
  name: "contest submit version: 固定版本不一致 → 409，一致/缺省放行",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const app = createApp();
    const adminId = crypto.randomUUID();
    const unique = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const problemId = crypto.randomUUID();
    const versionV1 = `${problemId}-v1`;
    const versionV2 = `${problemId}-v2`;
    // 题目编号/展示 ID 需唯一：用时间戳后 6 位（避免与其他测试文件撞号）
    const number = 986000 + (Date.now() % 1000);

    await db.insert(users).values({
      id: adminId,
      username: `csubmit-admin-${unique}`,
      email: `csubmit-admin-${unique}@example.com`,
      password_hash: "hash",
      created_at: now,
      updated_at: now,
    });
    await db.insert(userRoles).values({
      user_id: adminId,
      role_id: "admin",
    }).onConflictDoNothing();

    await db.insert(problems).values({
      id: problemId,
      title: "竞赛提交版本题",
      description: "d",
      type: "P",
      number,
      owner_id: "0",
      difficulty: "easy",
      created_at: now,
      updated_at: now,
    });
    for (const [version, id] of [[1, versionV1], [2, versionV2]] as const) {
      await db.insert(problemVersions).values({
        id,
        problem_id: problemId,
        version,
        schema_version: 1,
        origin: "published",
        content: {
          kind: "ai",
          title: "竞赛提交版本题",
          description: "d",
          samples: [],
          submission_mode: "code",
          runtime_config: {
            evaluator: {
              image: "noj-evaluator-python",
              command: "python3 /workspace/evaluate.py",
              time_limit_ms: 60000,
              memory_limit_mb: 512,
            },
            solution: {
              image: "noj-solution-python",
              call_timeout_ms: 60000,
              memory_limit_mb: 512,
            },
          },
          template_content: "",
          artifact_max_size_mb: null,
          llm_config: null,
        },
        content_sha256: `hash-${id}`,
        published_at: now,
      });
    }
    await db.update(problems).set({ latest_version_id: versionV2 }).where(
      eq(problems.id, problemId),
    );

    const adminToken = await signToken({ sub: adminId, role: "admin" });
    let contestId: string | undefined;
    const createdSubmissionIds: string[] = [];

    try {
      const create = await jsonRequest(app, "/api/v1/admin/contest/contests", {
        method: "POST",
        token: adminToken,
        body: {
          title: "提交版本校验赛",
          start_time: new Date(Date.now() - 60_000).toISOString(),
          end_time: new Date(Date.now() + 3_600_000).toISOString(),
          type: "kaggle",
          problems: [{
            problem_id: problemId,
            label: "A",
            sort_order: 0,
            score: 10000,
          }],
        },
      });
      assertEquals(create.status, 201);
      contestId = (await create.json()).data.id;

      // 创建竞赛即固定当时最新已发布版本，且题目详情下发作答版本
      const detail = await jsonRequest(
        app,
        `/api/v1/contests/${contestId}/problems/A`,
        { token: adminToken },
      );
      assertEquals(detail.status, 200);
      const detailData = (await detail.json()).data;
      assertEquals(detailData.version_id, versionV2);
      assertEquals(detailData.version, 2);

      // 客户端携带旧版本（页面缓存）→ 409，且不创建提交
      const stale = await jsonRequest(
        app,
        `/api/v1/contests/${contestId}/submit`,
        {
          method: "POST",
          token: adminToken,
          body: {
            problem_id: problemId,
            language: "python3",
            code: "print(1)",
            version_id: versionV1,
          },
        },
      );
      assertEquals(stale.status, 409);
      const staleBody = await stale.json();
      assertEquals(staleBody.code, "CONTEST_PROBLEM_VERSION_CHANGED");
      assertEquals(staleBody.expected_version_id, versionV2);
      assertEquals(staleBody.submitted_version_id, versionV1);

      // 携带一致版本 → 放行（Redis 不可用时为 500，但绝不能再是 409）
      const fresh = await jsonRequest(
        app,
        `/api/v1/contests/${contestId}/submit`,
        {
          method: "POST",
          token: adminToken,
          body: {
            problem_id: problemId,
            language: "python3",
            code: "print(2)",
            version_id: versionV2,
          },
        },
      );
      assertNotEquals(fresh.status, 409);
      if (fresh.status === 201) {
        createdSubmissionIds.push((await fresh.json()).data.id);
      }

      // 缺省版本：迁移期兼容（旧客户端）→ 仍用固定版本，不得 409
      const legacy = await jsonRequest(
        app,
        `/api/v1/contests/${contestId}/submit`,
        {
          method: "POST",
          token: adminToken,
          body: {
            problem_id: problemId,
            language: "python3",
            code: "print(3)",
          },
        },
      );
      assertNotEquals(legacy.status, 409);
      if (legacy.status === 201) {
        createdSubmissionIds.push((await legacy.json()).data.id);
      }

      // 落库版本必须是固定版本（v2），无论是显式携带还是缺省
      if (createdSubmissionIds.length > 0) {
        const rows = await db.select({
          submitted_version_id: submissions.submitted_version_id,
        }).from(submissions).where(
          inArray(submissions.id, createdSubmissionIds),
        );
        assertEquals(rows.length, createdSubmissionIds.length);
        for (const row of rows) {
          assertEquals(row.submitted_version_id, versionV2);
        }
      }
    } finally {
      if (createdSubmissionIds.length > 0) {
        await db.delete(submissions).where(
          inArray(submissions.id, createdSubmissionIds),
        );
      }
      if (contestId) {
        await db.delete(contests).where(inArray(contests.id, [contestId]));
      }
      // 先断掉 problems.latest_version_id 指针再删版本行（否则 FK 阻止删除）
      await db.update(problems).set({ latest_version_id: null }).where(
        eq(problems.id, problemId),
      );
      await db.delete(problemVersions).where(
        eq(problemVersions.problem_id, problemId),
      );
      await db.delete(problems).where(eq(problems.id, problemId));
    }
  },
});
