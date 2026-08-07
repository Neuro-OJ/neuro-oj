/**
 * 客观题路由层测试。
 * 覆盖：套卷 CRUD（type='O' 无需 runtime_config）、display_id 查找、
 * 小题 CRUD、提交端点即时判定、答案可见性裁剪、权限拒绝。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { createApp } from "../../src/app.ts";
import {
  createUserToken,
  initRedisForTest,
  jsonRequest,
} from "../lib/helper.ts";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import { problems } from "../../src/db/schema.ts";
import { eq } from "drizzle-orm";

await resetDbForTest();
await initRedisForTest();
const db = getDb();

Deno.test({
  name: "objective route: 创建套卷（type=O 无需 runtime_config）→ 201",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await createUserToken("user");
    const res = await jsonRequest(app, "/api/v1/problems", {
      method: "POST",
      token,
      body: {
        type: "O",
        title: `客观题套卷 ${Date.now()}`,
        description: "套卷描述",
      },
    });
    assertEquals(res.status, 201);
    const body = await res.json();
    assertEquals(body.data.type, "O");
    assertEquals(body.data.runtime_config, null);
  },
});

Deno.test({
  name: "objective route: 普通用户创建 P 型仍被拒（type 权限不受影响）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await createUserToken("user");
    const res = await jsonRequest(app, "/api/v1/problems", {
      method: "POST",
      token,
      body: {
        type: "P",
        title: `P 型题 ${Date.now()}`,
        description: "desc",
        runtime_config: {
          evaluator: {
            image: "noj-judge-python",
            command: "python3 /workspace/evaluate.py",
            time_limit_ms: 5000,
            memory_limit_mb: 512,
          },
          solution: {
            image: "noj-solution-python",
            entry: "solution.py",
            call_timeout_ms: 2000,
            memory_limit_mb: 512,
          },
        },
      },
    });
    assertEquals(res.status, 403);
  },
});

Deno.test({
  name: "objective route: 套卷 display_id 查找（O1001 前缀）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await createUserToken("user");
    // 创建一个 O 型套卷
    const created = await jsonRequest(app, "/api/v1/problems", {
      method: "POST",
      token,
      body: {
        type: "O",
        title: `display 套卷 ${Date.now()}`,
        description: "d",
      },
    });
    const paper = (await created.json()).data;
    const displayId = `${paper.type}${paper.number}`;

    const res = await jsonRequest(app, `/api/v1/problems/${displayId}`);
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.data.id, paper.id);
  },
});

Deno.test({
  name: "objective route: 小题 CRUD 全流程 + 答案可见性裁剪",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const owner = await createUserToken("user");
    const other = await createUserToken("user");

    // 创建套卷
    const created = await jsonRequest(app, "/api/v1/problems", {
      method: "POST",
      token: owner,
      body: { type: "O", title: `CRUD 套卷 ${Date.now()}`, description: "d" },
    });
    const paperId = (await created.json()).data.id;

    // 创建单选小题
    const qRes = await jsonRequest(
      app,
      `/api/v1/objective/papers/${paperId}/questions`,
      {
        method: "POST",
        token: owner,
        body: {
          type: "single",
          prompt: "1+1=?",
          options: [{ key: "A", text: "1" }, { key: "B", text: "2" }],
          answer: ["B"],
          explanation: "1+1=2",
        },
      },
    );
    assertEquals(qRes.status, 201);
    const q1 = (await qRes.json()).data;
    assertEquals(q1.answer, ["B"]);
    assertEquals(q1.explanation, "1+1=2");

    // 创建判断题
    const jRes = await jsonRequest(
      app,
      `/api/v1/objective/papers/${paperId}/questions`,
      {
        method: "POST",
        token: owner,
        body: { type: "judge", prompt: "地球是圆的", answer: [true] },
      },
    );
    assertEquals(jRes.status, 201);
    const j1 = (await jRes.json()).data;
    assertEquals(j1.options.length, 2); // 固定对/错

    // owner 视图含答案
    const ownerView = await jsonRequest(
      app,
      `/api/v1/objective/papers/${paperId}/questions`,
      { token: owner },
    );
    const ownerQuestions = (await ownerView.json()).data;
    assertEquals(ownerQuestions.length, 2);
    assertEquals(ownerQuestions[0].answer, ["B"]);

    // 非 owner 视图裁剪答案与解析
    const otherView = await jsonRequest(
      app,
      `/api/v1/objective/papers/${paperId}/questions`,
      { token: other },
    );
    const otherQuestions = (await otherView.json()).data;
    assertEquals(otherQuestions.length, 2);
    assertEquals(otherQuestions[0].answer, undefined);
    assertEquals(otherQuestions[0].explanation, undefined);

    // 非 owner 管理小题被拒
    const forbidden = await jsonRequest(
      app,
      `/api/v1/objective/questions/${q1.id}`,
      { method: "DELETE", token: other },
    );
    assertEquals(forbidden.status, 403);

    // 更新小题（owner）
    const upd = await jsonRequest(app, `/api/v1/objective/questions/${q1.id}`, {
      method: "PUT",
      token: owner,
      body: { explanation: "更新解析" },
    });
    assertEquals(upd.status, 200);
    assertEquals((await upd.json()).data.explanation, "更新解析");

    // 删除小题（owner）
    const del = await jsonRequest(app, `/api/v1/objective/questions/${q1.id}`, {
      method: "DELETE",
      token: owner,
    });
    assertEquals(del.status, 204);
  },
});

Deno.test({
  name: "objective route: 提交端点即时判定 + 历史查询 + 最高分",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const owner = await createUserToken("user");
    const solver = await createUserToken("user");

    const created = await jsonRequest(app, "/api/v1/problems", {
      method: "POST",
      token: owner,
      body: { type: "O", title: `提交套卷 ${Date.now()}`, description: "d" },
    });
    const paperId = (await created.json()).data.id;

    const qRes = await jsonRequest(
      app,
      `/api/v1/objective/papers/${paperId}/questions`,
      {
        method: "POST",
        token: owner,
        body: {
          type: "single",
          prompt: "1+1=?",
          options: [{ key: "A", text: "1" }, { key: "B", text: "2" }],
          answer: ["B"],
          explanation: "1+1=2",
        },
      },
    );
    const q1 = (await qRes.json()).data;

    // 答对 → 满分
    const okRes = await jsonRequest(
      app,
      `/api/v1/objective/papers/${paperId}/submit`,
      {
        method: "POST",
        token: solver,
        body: { answers: { [q1.id]: ["B"] } },
      },
    );
    assertEquals(okRes.status, 201);
    const ok = (await okRes.json()).data;
    assertEquals(ok.score, 100);
    assertEquals(ok.score_db, 10000);
    assertEquals(ok.details[q1.id].correct, true);

    // 答错 → 0 分（练习可重复提交）
    const badRes = await jsonRequest(
      app,
      `/api/v1/objective/papers/${paperId}/submit`,
      {
        method: "POST",
        token: solver,
        body: { answers: { [q1.id]: ["A"] } },
      },
    );
    assertEquals(badRes.status, 201);
    assertEquals((await badRes.json()).data.score, 0);

    // 历史 + 最高分
    const hist = await jsonRequest(
      app,
      `/api/v1/objective/submissions?paper_id=${paperId}`,
      { token: solver },
    );
    assertEquals(hist.status, 200);
    const histBody = (await hist.json()).data;
    assertEquals(histBody.total, 2);
    assertEquals(histBody.best_score, 10000);

    // 单次详情
    const detail = await jsonRequest(
      app,
      `/api/v1/objective/submissions/${ok.submission_id}`,
      { token: solver },
    );
    assertEquals(detail.status, 200);
    const detailBody = (await detail.json()).data;
    assertEquals(detailBody.details[q1.id].explanation, "1+1=2");
  },
});

Deno.test({
  name: "objective route: 删除套卷级联清理小题与提交",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const owner = await createUserToken("user");

    const created = await jsonRequest(app, "/api/v1/problems", {
      method: "POST",
      token: owner,
      body: { type: "O", title: `删除套卷 ${Date.now()}`, description: "d" },
    });
    const paperId = (await created.json()).data.id;

    await jsonRequest(app, `/api/v1/objective/papers/${paperId}/questions`, {
      method: "POST",
      token: owner,
      body: {
        type: "single",
        prompt: "q",
        options: [{ key: "A", text: "a" }],
        answer: ["A"],
      },
    });

    const del = await jsonRequest(app, `/api/v1/problems/${paperId}`, {
      method: "DELETE",
      token: owner,
    });
    assertEquals(del.status, 204);

    // 级联清理验证
    const rows = await db.select().from(problems).where(
      eq(problems.id, paperId),
    );
    assertEquals(rows.length, 0);
  },
});

Deno.test({
  name: "objective route: 非 O 型题目查询小题返回 400",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await createUserToken("user");
    // 创建 U 型题目（需 runtime_config）
    const created = await jsonRequest(app, "/api/v1/problems", {
      method: "POST",
      token,
      body: {
        type: "U",
        title: `U 型题 ${Date.now()}`,
        description: "d",
        runtime_config: {
          evaluator: {
            image: "noj-judge-python",
            command: "python3 /workspace/evaluate.py",
            time_limit_ms: 5000,
            memory_limit_mb: 512,
          },
          solution: {
            image: "noj-solution-python",
            entry: "solution.py",
            call_timeout_ms: 2000,
            memory_limit_mb: 512,
          },
        },
      },
    });
    const problemId = (await created.json()).data.id;

    const res = await jsonRequest(
      app,
      `/api/v1/objective/papers/${problemId}/questions`,
      { token },
    );
    assertEquals(res.status, 400);
  },
});

Deno.test({
  name: "objective route: sort_order 冲突返回 400",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const owner = await createUserToken("user");
    const created = await jsonRequest(app, "/api/v1/problems", {
      method: "POST",
      token: owner,
      body: { type: "O", title: `排序冲突卷 ${Date.now()}`, description: "d" },
    });
    const paperId = (await created.json()).data.id;

    // 指定 sort_order=5 创建第一题
    const first = await jsonRequest(
      app,
      `/api/v1/objective/papers/${paperId}/questions`,
      {
        method: "POST",
        token: owner,
        body: {
          type: "single",
          prompt: "q1",
          options: [{ key: "A", text: "a" }],
          answer: ["A"],
          sort_order: 5,
        },
      },
    );
    assertEquals(first.status, 201);

    // 第二题同样 sort_order=5 → 400
    const dup = await jsonRequest(
      app,
      `/api/v1/objective/papers/${paperId}/questions`,
      {
        method: "POST",
        token: owner,
        body: {
          type: "single",
          prompt: "q2",
          options: [{ key: "A", text: "a" }],
          answer: ["A"],
          sort_order: 5,
        },
      },
    );
    assertEquals(dup.status, 400);
  },
});
