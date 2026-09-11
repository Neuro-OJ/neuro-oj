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

    // 两个版本：v1 含逐题明细；v2 的用户名刻意以 `=` 开头，用于验证 CSV 注入防护。
    //
    // 分数一律使用**真实存储量纲**（×100 整数，见 submission/types 的 scoreToDb）：
    // 满分 100 分在库里是 10000。此前 fixture 写的是 100/90 这类流水线永远不会
    // 存入的值，导致「导出未换算」这个缺陷在结构上不可能被测出。
    const rowsV1 = [
      {
        rank: 1,
        user_id: "u1",
        username: "alice",
        avatar_url: null,
        total_score: 10000, // 展示分 100（满分）
        last_submission_at: "2026-01-01T10:00:00.000Z",
        problem_scores: [
          {
            label: "P1",
            best_score: 8750, // 展示分 87.5
            attempts: 2,
            last_best_at: "2026-01-01T10:00:00.000Z",
          },
          {
            label: "P2",
            best_score: 1250, // 展示分 12.5
            attempts: 1,
            last_best_at: "2026-01-01T11:00:00.000Z",
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
        total_score: 9000, // 展示分 90
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
      // BOM 必须存在于**线上字节**中（Excel 靠它识别 UTF-8 中文）。
      // 注意不能用 `text().charCodeAt(0)` 断言：流式响应的 TextDecoder 会按规范
      // 剥掉前导 BOM，该断言测的是解码产物而非真实契约。
      assertEquals(csvV1Res.headers.get("cache-control"), "private, no-store");
      const rawRes = await jsonRequest(app, `${base}/1.csv`, { token });
      const rawBytes = new Uint8Array(await rawRes.arrayBuffer());
      assertEquals(
        [...rawBytes.slice(0, 3)].join(","),
        "239,187,191",
        "响应体必须以 UTF-8 BOM 开头（ef bb bf）",
      );
      // 表头含逐题明细列（本次新增，此前明细被塞进一个 JSON 单元格）
      assertStringIncludes(csvV1, "题目标签");
      assertStringIncludes(csvV1, "题目最好成绩");
      // 逐题明细确实展开为一行
      assertStringIncludes(csvV1, "P1");

      // ── 2a. 分数必须换算为**展示量纲**（与页面榜单一致），不是库里的 ×100 原值 ──
      const csvRows = csvV1.trim().split("\n").slice(1);
      assertEquals(csvRows.length, 2, "v1 有 2 个题目明细 → 2 行");
      for (const line of csvRows) {
        const cols = line.split(",");
        assertEquals(cols.length, 9, `CSV 列数应为 9：${line}`);
        assertEquals(cols[3], "100", `总分应为展示分 100，实际 ${cols[3]}`);
      }
      assertEquals(csvRows[0]!.split(",")[6], "87.5", "P1 最好成绩应为 87.5");
      assertEquals(csvRows[1]!.split(",")[6], "12.5", "P2 最好成绩应为 12.5");
      assertEquals(
        csvV1.includes("10000") || csvV1.includes("8750"),
        false,
        "导出不得出现未换算的 ×100 原始分值",
      );

      // JSON 与 CSV 必须同口径——否则同一版本两个格式互相矛盾
      const jsonScale = await jsonRequest(app, `${base}/1.json`, { token });
      const bodyScale = await jsonScale.json();
      assertEquals(bodyScale.data.rows[0].total_score, 100);
      assertEquals(bodyScale.data.rows[0].problem_scores[0].best_score, 87.5);
      assertEquals(bodyScale.data.rows[0].problem_scores[1].best_score, 12.5);

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
      // v2 无逐题明细时仍应输出该用户一行（总分本身是有效信息），且同样换算
      const v2Cols = csvV2.trim().split("\n")[1]!.split(",");
      assertEquals(
        v2Cols.length,
        9,
        `无明细行也必须是 9 列：${v2Cols.join(",")}`,
      );
      assertEquals(v2Cols[3], "90", `总分应为展示分 90，实际 ${v2Cols[3]}`);
      assertEquals(v2Cols[2], "'=cmd|calc", "用户名应带注入防护前缀");

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

      // 已登录的**非管理员**必须 403：成绩单导出含全员成绩，属管理员数据。
      // 此前只覆盖了 401（未登录），漏掉了越权路径。
      const normalId = crypto.randomUUID();
      await db.insert(users).values({
        id: normalId,
        username: `exp-user-${normalId.slice(0, 8)}`,
        email: `exp-user-${normalId.slice(0, 8)}@test.com`,
        password_hash: "",
        created_at: now,
        updated_at: now,
      });
      const normalToken = await signToken({ sub: normalId, role: "user" });
      for (const path of ["1.json", "1.csv", "latest.json", "latest.csv"]) {
        const res = await jsonRequest(app, `${base}/${path}`, {
          token: normalToken,
        });
        assertEquals(res.status, 403, `非管理员访问 ${path} 应 403`);
      }
      await db.delete(users).where(eq(users.id, normalId));
    } finally {
      await db.delete(contestRankingSnapshots).where(
        eq(contestRankingSnapshots.contest_id, contestId),
      );
      await db.delete(contests).where(eq(contests.id, contestId));
      await db.delete(users).where(eq(users.id, adminId));
    }
  },
});

Deno.test({
  name: "ranking export: CSV 注入防护覆盖制表符/回车/前导空白",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const app = createApp();
    const now = new Date().toISOString();
    const adminId = crypto.randomUUID();
    const contestId = crypto.randomUUID();

    await db.insert(users).values({
      id: adminId,
      username: `inj-admin-${adminId.slice(0, 8)}`,
      email: `inj-admin-${adminId.slice(0, 8)}@test.com`,
      password_hash: "",
      created_at: now,
      updated_at: now,
    });
    await db.insert(userRoles).values({
      user_id: adminId,
      role_id: "admin",
    }).onConflictDoNothing();
    await db.insert(contests).values({
      id: contestId,
      title: "注入用例赛",
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

    // Excel/Sheets 对公式前缀的识别不限于行首字符：制表符与回车可起分隔作用，
    // 前导空白也可能被忽略后再按公式解析。旧实现只查 `^[=+\-@]`，全部漏掉。
    const payloads = [
      "\t=cmd|calc",
      "\r=cmd|calc",
      " =cmd|calc",
      "\t+cmd|calc",
    ];
    await db.insert(contestRankingSnapshots).values({
      id: crypto.randomUUID(),
      contest_id: contestId,
      version: 1,
      status: "published",
      note: "注入向量",
      rows: payloads.map((name, i) => ({
        rank: i + 1,
        user_id: `u${i}`,
        username: name,
        avatar_url: null,
        total_score: 1000,
        last_submission_at: null,
        problem_scores: [],
      })),
      created_by: adminId,
      created_at: now,
    });

    const token = await signToken({ sub: adminId, role: "admin" });
    try {
      const res = await jsonRequest(
        app,
        `/api/v1/admin/contest/contests/${contestId}/ranking-snapshots/1.csv`,
        { token },
      );
      assertEquals(res.status, 200);
      const csv = await res.text();
      const body = csv.slice(1); // 去掉 BOM
      const lines = body.trim().split("\n");
      assertEquals(lines.length, payloads.length + 1, "表头 + 每人一行");

      for (const line of lines.slice(1)) {
        // 每个数据行的用户名列都必须带 `'` 前缀（未被转义即为注入漏洞）
        const cols = line.split(",");
        assertEquals(cols.length, 9, `列数应为 9：${JSON.stringify(line)}`);
        const userCol = cols[2]!;
        assertEquals(
          userCol.startsWith("'") || userCol.startsWith('"'),
          true,
          `公式前缀未被中和：${JSON.stringify(userCol)}（整行 ${
            JSON.stringify(line)
          }）`,
        );
      }
    } finally {
      await db.delete(contestRankingSnapshots).where(
        eq(contestRankingSnapshots.contest_id, contestId),
      );
      await db.delete(contests).where(eq(contests.id, contestId));
      await db.delete(users).where(eq(users.id, adminId));
    }
  },
});
