/**
 * 客观题路由层测试。
 * 覆盖：套卷 CRUD（is_objective 无需 runtime_config）、display_id 查找、
 * 小题 CRUD、提交端点即时判定、答案可见性裁剪、权限拒绝。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { createApp } from "../../../../app.ts";
import {
  createUserToken,
  initRedisForTest,
  jsonRequest,
} from "../../../../../tests/helper.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import { createProblem } from "../../../../modules/problems/index.ts";
import { problems } from "../../../../shared/db/schema.ts";
import { eq } from "drizzle-orm";

await resetDbForTest();
await initRedisForTest();
const db = getDb();

/** 通过 visibility setter 将套卷转 public（owner 操作），供公开/他人访问场景。 */
async function makePaperPublic(
  app: ReturnType<typeof createApp>,
  paperId: string,
  token: string,
): Promise<void> {
  const res = await jsonRequest(
    app,
    `/api/v1/problems/${paperId}/visibility`,
    {
      method: "PUT",
      token,
      body: { visibility: "public" },
    },
  );
  if (res.status !== 200) {
    throw new Error(
      `套卷转 public 失败: ${res.status} ${JSON.stringify(await res.json())}`,
    );
  }
}

/**
 * 小题写入的草稿 revision 追踪（Handbook §2.4：小题编辑与草稿共用乐观锁）。
 *
 * 写入成功 → 采用响应里的新 `draft_revision`；失败（4xx）不递增，沿用当前值。
 */
const draftRevisions = new Map<string, number>();

async function draftRevision(
  app: ReturnType<typeof createApp>,
  paperId: string,
  token: string,
): Promise<number> {
  const cached = draftRevisions.get(paperId);
  if (cached !== undefined) return cached;
  const res = await jsonRequest(app, `/api/v1/problems/${paperId}/draft`, {
    token,
  });
  const revision = (await res.json()).data.revision as number;
  draftRevisions.set(paperId, revision);
  return revision;
}

/** 带草稿乐观锁的小题写入请求（`If-Match` + 响应回写新 revision）。 */
async function questionRequest(
  app: ReturnType<typeof createApp>,
  paperId: string,
  path: string,
  options: {
    method: "POST" | "PUT" | "DELETE";
    token: string;
    body?: Record<string, unknown>;
  },
): Promise<Response> {
  const revision = await draftRevision(app, paperId, options.token);
  const res = await jsonRequest(app, path, {
    method: options.method,
    token: options.token,
    headers: { "If-Match": String(revision) },
    ...(options.body ? { body: options.body } : {}),
  });
  if (res.ok) {
    const data = (await res.clone().json())?.data;
    if (data && typeof data.draft_revision === "number") {
      draftRevisions.set(paperId, data.draft_revision);
    }
  }
  return res;
}

/**
 * 发布套卷当前草稿为 V1（局部用例模板）。
 *
 * 已发布内容是**作答与公开读取**的事实源：非编辑者读小题、提交判卷都需要先发布。
 */
async function publishPaper(
  app: ReturnType<typeof createApp>,
  paperId: string,
  token: string,
): Promise<string> {
  const revision = await draftRevision(app, paperId, token);
  const res = await jsonRequest(app, `/api/v1/problems/${paperId}/versions`, {
    method: "POST",
    token,
    headers: { "If-Match": String(revision) },
    body: { change_note: "测试发布" },
  });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(
      `发布套卷失败: ${res.status} ${JSON.stringify(await res.json())}`,
    );
  }
  const data = (await res.json()).data;
  draftRevisions.set(paperId, data.draft_revision);
  return data.version_id as string;
}

Deno.test({
  name:
    "objective route: 创建客观题套卷（is_objective 无需 runtime_config）→ 201",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await createDefaultCatalogToken("editor");
    const res = await jsonRequest(app, "/api/v1/problems", {
      method: "POST",
      token,
      body: {
        is_objective: true,
        title: `客观题套卷 ${Date.now()}`,
        description: "套卷描述",
      },
    });
    assertEquals(res.status, 201);
    const body = await res.json();
    assertEquals(body.data.type, undefined);
    assertEquals(body.data.is_objective, true);
    assertEquals(body.data.runtime_config, null);
    // 默认社区域新建资源使用公开展示，未发布内容仍不可公开读取。
    assertEquals(body.data.visibility, "public");
  },
});

Deno.test({
  name: "objective route: 默认域创建明确拒绝旧题库分类",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await createDefaultCatalogToken("editor");
    const res = await jsonRequest(app, "/api/v1/problems", {
      method: "POST",
      token,
      body: {
        type: "P",
        title: `旧分类题 ${Date.now()}`,
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
            call_timeout_ms: 2000,
            memory_limit_mb: 512,
          },
        },
      },
    });
    assertEquals(res.status, 400);
  },
});

Deno.test({
  name: "objective route: 套卷数字题号与默认域 P 兼容入口",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await createDefaultCatalogToken("editor");
    // 创建一个客观题套卷
    const created = await jsonRequest(app, "/api/v1/problems", {
      method: "POST",
      token,
      body: {
        is_objective: true,
        title: `display 套卷 ${Date.now()}`,
        description: "d",
      },
    });
    const paper = (await created.json()).data;
    const displayId = String(paper.number);
    await makePaperPublic(app, paper.id, token);
    await publishBaselineVersionForTest(paper.id);

    const res = await jsonRequest(app, `/api/v1/problems/${displayId}`);
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.data.id, paper.id);
  },
});

Deno.test({
  name: "objective route: display_id 可创建/查询小题并提交（双索引落库）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const owner = await createDefaultCatalogToken("editor");
    // 创建套卷
    const created = await jsonRequest(app, "/api/v1/problems", {
      method: "POST",
      token: owner,
      body: {
        is_objective: true,
        title: `display 小题 ${Date.now()}`,
        description: "d",
      },
    });
    const paper = (await created.json()).data;
    const displayId = String(paper.number);
    await makePaperPublic(app, paper.id, owner);

    // 用 display_id 创建小题（不再只支持 UUID；写入走共享草稿 + 乐观锁）
    const qRes = await questionRequest(
      app,
      paper.id,
      `/api/v1/problems/${displayId}/questions`,
      {
        method: "POST",
        token: owner,
        body: {
          type: "single",
          prompt: "display id 小题",
          options: [{ key: "A", text: "1" }, { key: "B", text: "2" }],
          answer: ["B"],
        },
      },
    );
    assertEquals(qRes.status, 201);
    const q = (await qRes.json()).data;

    // 非编辑者读取需要已发布版本：发布 V1 后再读（提交必须显式携带该版本）
    const v1Id = await publishPaper(app, paper.id, owner);

    // 用 display_id 读取小题列表
    const listRes = await jsonRequest(
      app,
      `/api/v1/problems/${displayId}/questions`,
    );
    assertEquals(listRes.status, 200);
    const listBody = await listRes.json();
    assertEquals(listBody.data.length, 1);
    assertEquals(listBody.data[0].id, q.id);

    // 用 display_id 提交套卷答案（落库用 UUID）
    const subRes = await jsonRequest(
      app,
      `/api/v1/problems/${displayId}/submit`,
      {
        method: "POST",
        token: owner,
        body: { answers: { [q.id]: ["B"] }, version_id: v1Id },
      },
    );
    assertEquals(subRes.status, 201);
    const subBody = await subRes.json();
    assertEquals(subBody.data.score, 100);

    // 用 display_id 查提交历史（落库以 UUID 为键，display_id 应可命中）
    const histRes = await jsonRequest(
      app,
      `/api/v1/problems/submissions?paper_id=${displayId}`,
      { token: owner },
    );
    assertEquals(histRes.status, 200);
    const histBody = await histRes.json();
    assertEquals(histBody.data.total, 1);
  },
});

Deno.test({
  name: "objective route: 提交历史 paper_id 不存在时返回空列表而非 404",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const owner = await createDefaultCatalogToken("editor");
    const res = await jsonRequest(
      app,
      "/api/v1/problems/submissions?paper_id=00000000-0000-0000-0000-000000000000",
      { token: owner },
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.data.total, 0);
  },
});

Deno.test({
  name: "objective route: 小题 CRUD 全流程 + 答案可见性裁剪",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const owner = await createDefaultCatalogToken("editor");
    const other = await createDefaultCatalogToken("editor");

    // 创建套卷
    const created = await jsonRequest(app, "/api/v1/problems", {
      method: "POST",
      token: owner,
      body: {
        is_objective: true,
        title: `CRUD 套卷 ${Date.now()}`,
        description: "d",
      },
    });
    const paperId = (await created.json()).data.id;
    await makePaperPublic(app, paperId, owner);

    // 创建单选小题
    const qRes = await questionRequest(
      app,
      paperId,
      `/api/v1/problems/${paperId}/questions`,
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
    const jRes = await questionRequest(
      app,
      paperId,
      `/api/v1/problems/${paperId}/questions`,
      {
        method: "POST",
        token: owner,
        body: { type: "judge", prompt: "地球是圆的", answer: [true] },
      },
    );
    assertEquals(jRes.status, 201);
    const j1 = (await jRes.json()).data;
    assertEquals(j1.options.length, 2); // 固定对/错

    // 发布 V1：非编辑者读的是版本快照
    await publishPaper(app, paperId, owner);

    // owner 视图含答案（读草稿）
    const ownerView = await jsonRequest(
      app,
      `/api/v1/problems/${paperId}/questions`,
      { token: owner },
    );
    const ownerQuestions = (await ownerView.json()).data;
    assertEquals(ownerQuestions.length, 2);
    assertEquals(ownerQuestions[0].answer, ["B"]);

    // 非 owner 视图裁剪答案与解析
    const otherView = await jsonRequest(
      app,
      `/api/v1/problems/${paperId}/questions`,
      { token: other },
    );
    const otherQuestions = (await otherView.json()).data;
    assertEquals(otherQuestions.length, 2);
    assertEquals(otherQuestions[0].answer, undefined);
    assertEquals(otherQuestions[0].explanation, undefined);

    // 非 owner 管理小题被拒（权限判定先于乐观锁，无需携带 revision）
    const forbidden = await jsonRequest(
      app,
      `/api/v1/problems/${paperId}/questions/${q1.id}`,
      { method: "DELETE", token: other },
    );
    assertEquals(forbidden.status, 403);

    // 缺少预期 revision → 428（不静默覆盖他人草稿）
    const missingRevision = await jsonRequest(
      app,
      `/api/v1/problems/${paperId}/questions/${q1.id}`,
      {
        method: "PUT",
        token: owner,
        body: { explanation: "不应保存" },
      },
    );
    assertEquals(missingRevision.status, 428);

    // 更新小题（owner）
    const upd = await questionRequest(
      app,
      paperId,
      `/api/v1/problems/${paperId}/questions/${q1.id}`,
      {
        method: "PUT",
        token: owner,
        body: { explanation: "更新解析" },
      },
    );
    assertEquals(upd.status, 200);
    const updBody = (await upd.json()).data;
    assertEquals(updBody.explanation, "更新解析");
    assertEquals(typeof updBody.draft_revision, "number");

    // 删除小题（owner）：200 + 新 revision（不再 204）
    const del = await questionRequest(
      app,
      paperId,
      `/api/v1/problems/${paperId}/questions/${q1.id}`,
      { method: "DELETE", token: owner },
    );
    assertEquals(del.status, 200);
    assertEquals(
      typeof (await del.json()).data.draft_revision,
      "number",
    );

    // 已发布 V1 的快照不受草稿删除影响（作答视图仍能看到两题）
    const publicAfterDelete = await jsonRequest(
      app,
      `/api/v1/problems/${paperId}/questions`,
      { token: other },
    );
    assertEquals((await publicAfterDelete.json()).data.length, 2);
  },
});

Deno.test({
  name: "objective route: 提交端点即时判定 + 历史查询 + 最高分",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const owner = await createDefaultCatalogToken("editor");
    const solver = await createDefaultCatalogToken("editor");

    const created = await jsonRequest(app, "/api/v1/problems", {
      method: "POST",
      token: owner,
      body: {
        is_objective: true,
        title: `提交套卷 ${Date.now()}`,
        description: "d",
      },
    });
    const paperId = (await created.json()).data.id;
    await makePaperPublic(app, paperId, owner);

    const qRes = await questionRequest(
      app,
      paperId,
      `/api/v1/problems/${paperId}/questions`,
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

    // 判卷事实源是**已发布版本**快照：发布 V1 后再提交（提交显式携带版本）
    const publishedVersionId = await publishPaper(app, paperId, owner);

    // 答对 → 满分
    const okRes = await jsonRequest(
      app,
      `/api/v1/problems/${paperId}/submit`,
      {
        method: "POST",
        token: solver,
        body: { answers: { [q1.id]: ["B"] }, version_id: publishedVersionId },
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
      `/api/v1/problems/${paperId}/submit`,
      {
        method: "POST",
        token: solver,
        body: { answers: { [q1.id]: ["A"] }, version_id: publishedVersionId },
      },
    );
    assertEquals(badRes.status, 201);
    assertEquals((await badRes.json()).data.score, 0);

    // 历史 + 最高分
    const hist = await jsonRequest(
      app,
      `/api/v1/problems/submissions?paper_id=${paperId}`,
      { token: solver },
    );
    assertEquals(hist.status, 200);
    const histBody = (await hist.json()).data;
    assertEquals(histBody.total, 2);
    assertEquals(histBody.best_score, 10000);

    // 单次详情
    const detail = await jsonRequest(
      app,
      `/api/v1/problems/submissions/${ok.submission_id}`,
      { token: solver },
    );
    assertEquals(detail.status, 200);
    const detailBody = (await detail.json()).data;
    assertEquals(detailBody.details[q1.id].explanation, "1+1=2");
  },
});

Deno.test({
  name: "objective route: 编辑者不能物理删除，已发布套卷保留版本及身份",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const owner = await createDefaultCatalogToken("editor");

    const created = await jsonRequest(app, "/api/v1/problems", {
      method: "POST",
      token: owner,
      body: {
        is_objective: true,
        title: `删除套卷 ${Date.now()}`,
        description: "d",
      },
    });
    const paperId = (await created.json()).data.id;

    await questionRequest(
      app,
      paperId,
      `/api/v1/problems/${paperId}/questions`,
      {
        method: "POST",
        token: owner,
        body: {
          type: "single",
          prompt: "q",
          options: [{ key: "A", text: "a" }],
          answer: ["A"],
        },
      },
    );

    const del = await jsonRequest(app, `/api/v1/problems/${paperId}`, {
      method: "DELETE",
      token: owner,
    });
    assertEquals(del.status, 403);
    await publishPaper(app, paperId, owner);
    const admin = await createDefaultCatalogToken("admin");
    const governedDelete = await jsonRequest(
      app,
      `/api/v1/problems/${paperId}`,
      { method: "DELETE", token: admin },
    );
    assertEquals(governedDelete.status, 409);

    // 已发布历史不能被物理删除
    const rows = await db.select().from(problems).where(
      eq(problems.id, paperId),
    );
    assertEquals(rows.length, 1);
  },
});

Deno.test({
  name: "objective route: 非 O 型题目查询小题返回 400",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await createDefaultCatalogToken("editor");
    // 服务层直接创建 编程题（内部 root 路径，不受普通用户敏感字段限制）
    const created = await createProblem({
      title: `编程题 ${Date.now()}`,
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
          call_timeout_ms: 2000,
          memory_limit_mb: 512,
        },
      },
    });
    const problemId = created.id;

    const res = await jsonRequest(
      app,
      `/api/v1/problems/${problemId}/questions`,
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
    const owner = await createDefaultCatalogToken("editor");
    const created = await jsonRequest(app, "/api/v1/problems", {
      method: "POST",
      token: owner,
      body: {
        is_objective: true,
        title: `排序冲突卷 ${Date.now()}`,
        description: "d",
      },
    });
    const paperId = (await created.json()).data.id;

    // 指定 sort_order=5 创建第一题
    const first = await questionRequest(
      app,
      paperId,
      `/api/v1/problems/${paperId}/questions`,
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

    // 第二题同样 sort_order=5 → 400（草稿内排序号唯一）
    const dup = await questionRequest(
      app,
      paperId,
      `/api/v1/problems/${paperId}/questions`,
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

Deno.test({
  name: "objective route: sort_order 非整数/负数被拒",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const owner = await createDefaultCatalogToken("editor");
    const created = await jsonRequest(app, "/api/v1/problems", {
      method: "POST",
      token: owner,
      body: {
        is_objective: true,
        title: `排序校验卷 ${Date.now()}`,
        description: "d",
      },
    });
    const paperId = (await created.json()).data.id;

    for (const bad of [-1, 1.5]) {
      const res = await questionRequest(
        app,
        paperId,
        `/api/v1/problems/${paperId}/questions`,
        {
          method: "POST",
          token: owner,
          body: {
            type: "single",
            prompt: "q",
            options: [{ key: "A", text: "a" }],
            answer: ["A"],
            sort_order: bad,
          },
        },
      );
      assertEquals(res.status, 400, `sort_order=${bad} 应被拒`);
    }
  },
});

Deno.test({
  name: "objective route: 默认域管理员套卷不能由其他编辑者管理",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const admin = await createUserToken("admin");
    const normal = await createDefaultCatalogToken("editor");

    // admin 创建 客观题套卷
    const created = await jsonRequest(app, "/api/v1/problems", {
      method: "POST",
      token: admin,
      body: {
        is_objective: true,
        title: `管理员套卷 ${Date.now()}`,
        description: "d",
      },
    });
    assertEquals(created.status, 201);
    const paperId = (await created.json()).data.id;

    // 普通用户创建小题被拒（未获该源题编辑能力）
    const qRes = await jsonRequest(
      app,
      `/api/v1/problems/${paperId}/questions`,
      {
        method: "POST",
        token: normal,
        body: {
          type: "single",
          prompt: "q",
          options: [{ key: "A", text: "a" }],
          answer: ["A"],
        },
      },
    );
    assertEquals(qRes.status, 403);

    // admin 可创建小题并查看答案
    const adminQ = await questionRequest(
      app,
      paperId,
      `/api/v1/problems/${paperId}/questions`,
      {
        method: "POST",
        token: admin,
        body: {
          type: "single",
          prompt: "q",
          options: [{ key: "A", text: "a" }],
          answer: ["A"],
        },
      },
    );
    assertEquals(adminQ.status, 201);

    // 非编辑者读版本快照：先发布 V1
    await publishPaper(app, paperId, admin);

    // 普通用户公开视图：题目可读但答案被裁剪
    const view = await jsonRequest(
      app,
      `/api/v1/problems/${paperId}/questions`,
      { token: normal },
    );
    assertEquals(view.status, 200);
    const ownerQuestions = (await view.json()).data;
    assertEquals(ownerQuestions[0].answer, undefined);

    // admin 视图含答案
    const adminView = await jsonRequest(
      app,
      `/api/v1/problems/${paperId}/questions`,
      { token: admin },
    );
    const adminQuestions = (await adminView.json()).data;
    assertEquals(adminQuestions[0].answer, ["A"]);
  },
});

Deno.test({
  name: "objective route: 改题型时既有答案必须对新题型合法",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const owner = await createDefaultCatalogToken("editor");
    const created = await jsonRequest(app, "/api/v1/problems", {
      method: "POST",
      token: owner,
      body: {
        is_objective: true,
        title: `改题型卷 ${Date.now()}`,
        description: "d",
      },
    });
    const paperId = (await created.json()).data.id;

    // 单选 → 判断题：旧答案 ["A"] 不是布尔 → 400（需同时传新 answer）
    const single = await questionRequest(
      app,
      paperId,
      `/api/v1/problems/${paperId}/questions`,
      {
        method: "POST",
        token: owner,
        body: {
          type: "single",
          prompt: "q1",
          options: [{ key: "A", text: "a" }, { key: "B", text: "b" }],
          answer: ["A"],
        },
      },
    );
    const singleQ = (await single.json()).data;
    const toJudge = await questionRequest(
      app,
      paperId,
      `/api/v1/problems/${paperId}/questions/${singleQ.id}`,
      {
        method: "PUT",
        token: owner,
        body: { type: "judge" },
      },
    );
    assertEquals(toJudge.status, 400);

    // 判断题 → 单选：不传 options 固定对/错不可复用 → 400
    const judge = await questionRequest(
      app,
      paperId,
      `/api/v1/problems/${paperId}/questions`,
      {
        method: "POST",
        token: owner,
        body: { type: "judge", prompt: "q2", answer: [true] },
      },
    );
    const judgeQ = (await judge.json()).data;
    const toSingle = await questionRequest(
      app,
      paperId,
      `/api/v1/problems/${paperId}/questions/${judgeQ.id}`,
      {
        method: "PUT",
        token: owner,
        body: { type: "single" },
      },
    );
    assertEquals(toSingle.status, 400);

    // 单选 → 多选：旧答案 1 项对多选仍合法（非空不重复）→ 200
    const toMultiple = await questionRequest(
      app,
      paperId,
      `/api/v1/problems/${paperId}/questions/${singleQ.id}`,
      {
        method: "PUT",
        token: owner,
        body: { type: "multiple" },
      },
    );
    assertEquals(toMultiple.status, 200);
    assertEquals((await toMultiple.json()).data.answer, ["A"]);
  },
});

Deno.test({
  name:
    "objective route: 编辑者读草稿、作答者读版本快照（发布 V2 后才可见新小题）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const owner = await createDefaultCatalogToken("editor");
    const solver = await createDefaultCatalogToken("editor");

    const created = await jsonRequest(app, "/api/v1/problems", {
      method: "POST",
      token: owner,
      body: {
        is_objective: true,
        title: `快照隔离卷 ${Date.now()}`,
        description: "d",
      },
    });
    const paperId = (await created.json()).data.id;
    await makePaperPublic(app, paperId, owner);

    // V1：一题
    const q1Res = await questionRequest(
      app,
      paperId,
      `/api/v1/problems/${paperId}/questions`,
      {
        method: "POST",
        token: owner,
        body: {
          type: "single",
          prompt: "V1 题目",
          options: [{ key: "A", text: "a" }, { key: "B", text: "b" }],
          answer: ["A"],
        },
      },
    );
    const q1 = (await q1Res.json()).data;
    await publishPaper(app, paperId, owner);

    // 草稿：改题干 + 加第二题（发布前不影响作答视图）
    const edited = await questionRequest(
      app,
      paperId,
      `/api/v1/problems/${paperId}/questions/${q1.id}`,
      {
        method: "PUT",
        token: owner,
        body: { prompt: "V2 题目" },
      },
    );
    assertEquals(edited.status, 200);
    await questionRequest(
      app,
      paperId,
      `/api/v1/problems/${paperId}/questions`,
      {
        method: "POST",
        token: owner,
        body: {
          type: "judge",
          prompt: "V2 新增判断",
          answer: [true],
        },
      },
    );

    // 编辑者读草稿：两题、新题干
    const draftView = await jsonRequest(
      app,
      `/api/v1/problems/${paperId}/questions`,
      { token: owner },
    );
    const draftQuestions = (await draftView.json()).data;
    assertEquals(draftQuestions.length, 2);
    assertEquals(draftQuestions[0].prompt, "V2 题目");

    // 作答者读版本快照：仍是一题、旧题干
    const solverView = await jsonRequest(
      app,
      `/api/v1/problems/${paperId}/questions`,
      { token: solver },
    );
    const solverQuestions = (await solverView.json()).data;
    assertEquals(solverQuestions.length, 1);
    assertEquals(solverQuestions[0].prompt, "V1 题目");
    assertEquals(solverQuestions[0].answer, undefined);

    // 发布 V2 后作答视图切到新快照
    await publishPaper(app, paperId, owner);
    const solverView2 = await jsonRequest(
      app,
      `/api/v1/problems/${paperId}/questions`,
      { token: solver },
    );
    const solverQuestions2 = (await solverView2.json()).data;
    assertEquals(solverQuestions2.length, 2);
    assertEquals(solverQuestions2[0].prompt, "V2 题目");
  },
});

import { resetDbForTest } from "../../../../modules/problems/tests/default-fixture.ts";

import { createDefaultCatalogToken } from "../../../../modules/problems/tests/default-fixture.ts";

import { publishBaselineVersionForTest } from "../../../../../tests/helper.ts";
