/**
 * 正式成绩导出路由测试（成绩单导出补全）。
 *
 * 覆盖本次新增的历史版本导出能力，以及既有 latest.* 与错误路径：
 * - `GET /contests/:id/ranking-snapshots/<version>.json` / `.csv`
 * - 与静态同级路由（`readiness` / `latest` / `latest.json` / `latest.csv`）的路由优先级
 * - 版本不存在 → 404；版本号/扩展名非法 → 400
 * - CSV 逐题明细与 **CSV 注入防护**（以 `= + - @` 开头的单元格加 `'` 前缀）
 * - 未认证 → 401
 */

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { createApp } from "../../../../app.ts";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import {
  contestRankingSnapshots,
  contests,
  userRoles,
  users,
} from "../../../../shared/db/schema.ts";
import { signToken } from "../../../identity/index.ts";
import { initRedisForTest, jsonRequest } from "../../../../../tests/helper.ts";

await resetDbForTest();
await initRedisForTest();

Deno.test({
  name: "ranking export: 历史版本导出、路由优先级与错误路径",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const app = createApp();

    const adminId = crypto.randomUUID();
    const contestId = crypto.randomUUID();
    const now = new Date().toISOString();

    await db.insert(users).values({
      id: adminId,
      username: `exp-admin-${adminId.slice(0, 8)}`,
      email: `exp-admin-${adminId.slice(0, 8)}@test.com`,
      password_hash: "",
      created_at: now,
      updated_at: now,
    });
    // 授予 admin 角色：管理端路由经 RBAC 校验，仅有 users 行不够
    await db.insert(userRoles).values({
      user_id: adminId,
      role_id: "admin",
    }).onConflictDoNothing();
    await db.insert(contests).values({
      id: contestId,
      title: "导出测试赛",
      start_time: "2026-01-01T00:00:00.000Z",
      end_time: "2026-01-02T00:00:00.000Z",
      type: "kaggle",
      kind: "public",
      is_public: true,
      config: {},
      created_by: adminId,
      created_at: now,
      updated_at: now,
    });

    // 两个版本：v1 含逐题明细；v2 的用户名刻意以 `=` 开头，用于验证 CSV 注入防护
    const rowsV1 = [
      {
        rank: 1,
        user_id: "u1",
        username: "alice",
        avatar_url: null,
        total_score: 100,
        last_submission_at: "2026-01-01T10:00:00.000Z",
        problem_scores: [
          {
            label: "P1",
            best_score: 100,
            attempts: 2,
            last_best_at: "2026-01-01T10:00:00.000Z",
          },
        ],
      },
    ];
    const rowsV2 = [
      {
        rank: 1,
        user_id: "u2",
        username: "=cmd|calc",
        avatar_url: null,
        total_score: 90,
        last_submission_at: null,
        problem_scores: [],
      },
    ];

    await db.insert(contestRankingSnapshots).values([
      {
        id: crypto.randomUUID(),
        contest_id: contestId,
        version: 1,
        status: "published",
        note: "v1 初版",
        rows: rowsV1,
        created_by: adminId,
        created_at: "2026-01-02T00:00:00.000Z",
      },
      {
        id: crypto.randomUUID(),
        contest_id: contestId,
        version: 2,
        status: "published",
        note: "v2 修订",
        rows: rowsV2,
        created_by: adminId,
        created_at: "2026-01-03T00:00:00.000Z",
      },
    ]);

    const token = await signToken({ sub: adminId, role: "admin" });
    const base =
      `/api/v1/admin/contest/contests/${contestId}/ranking-snapshots`;

    try {
      // ── 1. 历史版本 JSON 导出：必须返回**该版本**的 rows，而不是最新版 ──
      const jsonV1 = await jsonRequest(app, `${base}/1.json`, { token });
      assertEquals(jsonV1.status, 200);
      const bodyV1 = await jsonV1.json();
      assertEquals(bodyV1.data.version, 1);
      assertEquals(bodyV1.data.note, "v1 初版");
      assertEquals(bodyV1.data.rows[0].username, "alice");

      // 与 latest 区分：latest 应给 v2
      const latest = await jsonRequest(app, `${base}/latest.json`, { token });
      assertEquals(latest.status, 200);
      const bodyLatest = await latest.json();
      assertEquals(bodyLatest.data.version, 2, "latest 应返回最新版本 v2");

      // ── 2. 历史版本 CSV：逐题明细展开 + 注入防护 ──
      const csvV1Res = await jsonRequest(app, `${base}/1.csv`, { token });
      assertEquals(csvV1Res.status, 200);
      assertEquals(
        csvV1Res.headers.get("content-type"),
        "text/csv; charset=utf-8",
      );
      assertStringIncludes(
        csvV1Res.headers.get("content-disposition") ?? "",
        `contest-${contestId}-ranking-v1.csv`,
      );
      const csvV1 = await csvV1Res.text();
      // BOM 保证 Excel 正确识别中文
      assertEquals(csvV1.charCodeAt(0), 0xfeff);
      // 表头含逐题明细列（本次新增，此前明细被塞进一个 JSON 单元格）
      assertStringIncludes(csvV1, "题目标签");
      assertStringIncludes(csvV1, "题目最好成绩");
      // 逐题明细确实展开为一行
      assertStringIncludes(csvV1, "P1");

      // CSV 注入防护：`=cmd|calc` 必须被加上 `'` 前缀
      const csvV2Res = await jsonRequest(app, `${base}/2.csv`, { token });
      assertEquals(csvV2Res.status, 200);
      const csvV2 = await csvV2Res.text();
      assertStringIncludes(csvV2, "'=cmd|calc");
      assertEquals(
        csvV2.includes(",=cmd|calc"),
        false,
        "不得出现未转义的公式前缀（CSV 注入）",
      );
      // v2 无逐题明细时仍应输出该用户一行（总分本身是有效信息）
      assertStringIncludes(csvV2, "90");

      // ── 3. 静态同级路由未被 :file 抢占 ──
      for (const path of ["readiness", "latest", "latest.json", "latest.csv"]) {
        const res = await jsonRequest(app, `${base}/${path}`, { token });
        assertEquals(res.status, 200, `${path} 不应被 :file 路由抢占`);
      }
      // 列表（无子路径）亦不受影响
      const listRes = await jsonRequest(app, base, { token });
      assertEquals(listRes.status, 200);
      const listBody = await listRes.json();
      assertEquals(listBody.data.length, 2, "列表应返回两个版本元数据");

      // ── 4. 版本不存在 → 404（且不得静默回退到最新版）──
      const missing = await jsonRequest(app, `${base}/99.json`, { token });
      assertEquals(missing.status, 404);

      // ── 5. 非法版本号 / 扩展名 → 400 ──
      for (const bad of ["0.json", "abc.json", "1.txt", "1", "1.JSON"]) {
        const res = await jsonRequest(app, `${base}/${bad}`, { token });
        assertEquals(res.status, 400, `${bad} 应返回 400`);
      }

      // ── 6. 认证与授权 ──
      const noAuth = await jsonRequest(app, `${base}/1.json`);
      assertEquals(noAuth.status, 401);
    } finally {
      await db.delete(contestRankingSnapshots).where(
        eq(contestRankingSnapshots.contest_id, contestId),
      );
      await db.delete(contests).where(eq(contests.id, contestId));
      await db.delete(users).where(eq(users.id, adminId));
    }
  },
});
