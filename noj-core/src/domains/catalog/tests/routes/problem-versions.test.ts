/**
 * 题目草稿与版本路由测试（Handbook §4.1、§5.2、§5.3）。
 *
 * 覆盖：编辑者读取派生草稿、乐观锁 428/409、发布预检、发布新版本、
 * 相同内容重复发布（unchanged）、版本列表与指定版本读取（非编辑者答案裁剪）、
 * 非编辑者访问草稿被拒。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { initRedisForTest } from "../../../../../tests/helper.ts";
import { createApp } from "../../../../app.ts";
import { createProblem } from "../../index.ts";
import { resetDbForTest } from "../../../../shared/db/connection.ts";
import { jsonRequest } from "../../../../../tests/helper.ts";

const hasEnv = !!Deno.env.get("JWT_SECRET");
const skip = !hasEnv;

const ts = Date.now();

await resetDbForTest();
await initRedisForTest();

const runtimeConfig = {
  evaluator: {
    image: "noj-evaluator-python",
    command: "python3 /workspace/evaluate.py",
    time_limit_ms: 5000,
    memory_limit_mb: 512,
  },
  solution: {
    image: "noj-solution-python",
    call_timeout_ms: 2000,
    memory_limit_mb: 512,
  },
};

/** 建一道 U 型题（内容完整，仅用于草稿/版本接口）。 */
async function makeDraftProblem(): Promise<string> {
  const created = await createProblem({
    title: `草稿路由题 ${ts}_${Math.random().toString(36).slice(2, 8)}`,
    description: "初始题面",
    difficulty: "easy",
    samples: [],
    runtime_config: runtimeConfig,
  });
  return created.id;
}

/** 管理员 token（U 型非 owner 需要 problem:write_any）。 */
async function adminToken(): Promise<string> {
  const { createUserToken } = await import("../../../../../tests/helper.ts");
  return await createUserToken("admin");
}

function draftContent(title: string, description = "题面") {
  return {
    kind: "ai",
    title,
    description,
    samples: [],
    submission_mode: "code",
    runtime_config: runtimeConfig,
    template_content: "",
    artifact_max_size_mb: null,
    llm_config: null,
  };
}

Deno.test({
  name: "problem versions route: 读取派生草稿（revision=0，synthesized）",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const problemId = await makeDraftProblem();
    const app = createApp();
    const token = await adminToken();

    const res = await jsonRequest(
      app,
      `/api/v1/problems/${problemId}/draft`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.data.problem_id, problemId);
    assertEquals(body.data.revision, 0);
    assertEquals(body.data.synthesized, true);
    assertEquals(body.data.content.kind, "ai");
  },
});

Deno.test({
  name: "problem versions route: 草稿写入缺 If-Match 返回 428，过时返回 409",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const problemId = await makeDraftProblem();
    const app = createApp();
    const token = await adminToken();
    const url = `/api/v1/problems/${problemId}/draft`;

    // 缺少预期 revision：428（避免盲写覆盖他人编辑）
    const missing = await jsonRequest(app, url, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}` },
      body: { content: draftContent("改后题面") },
    });
    assertEquals(missing.status, 428);

    // 正确 revision → 写入成功并递增
    const saved = await jsonRequest(app, url, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "If-Match": "0" },
      body: { content: draftContent("改后题面") },
    });
    assertEquals(saved.status, 200);
    const savedBody = await saved.json();
    assertEquals(savedBody.data.revision, 1);
    assertEquals(savedBody.data.content.title, "改后题面");

    // 过时 revision → 409
    const stale = await jsonRequest(app, url, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "If-Match": "0" },
      body: { content: draftContent("再次修改") },
    });
    assertEquals(stale.status, 409);
  },
});

Deno.test({
  name:
    "problem versions route: 发布预检 → 发布 V1 → 相同内容重复发布 unchanged",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const problemId = await makeDraftProblem();
    const app = createApp();
    const token = await adminToken();
    const auth = { Authorization: `Bearer ${token}` };

    await jsonRequest(app, `/api/v1/problems/${problemId}/draft`, {
      method: "PUT",
      headers: { ...auth, "If-Match": "0" },
      body: { content: draftContent("V1 题面") },
    });

    // 预检：内容完整 → ready
    const preflight = await jsonRequest(
      app,
      `/api/v1/problems/${problemId}/draft/preflight`,
      { headers: auth },
    );
    assertEquals(preflight.status, 200);
    const report = await preflight.json();
    assertEquals(report.data.ready, true);
    assertEquals(report.data.revision, 1);

    // 发布 V1
    const published = await jsonRequest(
      app,
      `/api/v1/problems/${problemId}/versions`,
      {
        method: "POST",
        headers: { ...auth, "If-Match": "1" },
        body: { change_note: "首版" },
      },
    );
    assertEquals(published.status, 201);
    const publishedBody = await published.json();
    assertEquals(publishedBody.data.version, 1);
    assertEquals(publishedBody.data.unchanged, false);
    const versionId = publishedBody.data.version_id as string;

    // 相同内容重复发布：不制造空版本
    const again = await jsonRequest(
      app,
      `/api/v1/problems/${problemId}/versions`,
      {
        method: "POST",
        headers: {
          ...auth,
          "If-Match": String(publishedBody.data.draft_revision),
        },
        body: { change_note: "重复发布" },
      },
    );
    assertEquals(again.status, 200);
    const againBody = await again.json();
    assertEquals(againBody.data.unchanged, true);
    assertEquals(againBody.data.version_id, versionId);

    // 版本列表包含 V1 且标记为最新版
    const list = await jsonRequest(
      app,
      `/api/v1/problems/${problemId}/versions`,
      { headers: auth },
    );
    assertEquals(list.status, 200);
    const listBody = await list.json();
    assertEquals(listBody.total, 1);
    assertEquals(listBody.data[0].version, 1);
    assertEquals(listBody.data[0].is_latest, true);

    // 指定版本读取
    const one = await jsonRequest(
      app,
      `/api/v1/problems/${problemId}/versions/${versionId}`,
      { headers: auth },
    );
    assertEquals(one.status, 200);
    const oneBody = await one.json();
    assertEquals(oneBody.data.version, 1);
    assertEquals(oneBody.data.is_latest, true);
    assertEquals(oneBody.data.content.title, "V1 题面");
  },
});

Deno.test({
  name: "problem versions route: 客观题版本对非编辑者裁剪标准答案",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // 公开套卷：普通用户可读（private 套卷对非 owner 一律 404，无法验证裁剪）
    const paper = await createProblem({
      title: `客观题草稿路由 ${ts}`,
      description: "套卷",
      difficulty: "easy",
      is_objective: true,
      visibility: "public",
    });
    const app = createApp();
    const editor = await adminToken();
    const auth = { Authorization: `Bearer ${editor}` };

    // 直接写完整客观题草稿（小题 key 稳定）
    const content = {
      kind: "objective",
      title: "客观题草稿路由",
      description: "套卷",
      samples: [],
      questions: [{
        key: "q-key-1",
        sort_order: 0,
        type: "single",
        prompt: "1+1=?",
        options: [{ key: "A", text: "2" }, { key: "B", text: "3" }],
        answer: ["A"],
        explanation: "基础题",
      }],
    };
    const saved = await jsonRequest(app, `/api/v1/problems/${paper.id}/draft`, {
      method: "PUT",
      headers: { ...auth, "If-Match": "0" },
      body: { content },
    });
    assertEquals(saved.status, 200);

    const published = await jsonRequest(
      app,
      `/api/v1/problems/${paper.id}/versions`,
      {
        method: "POST",
        headers: { ...auth, "If-Match": "1" },
        body: { change_note: "V1" },
      },
    );
    assertEquals(published.status, 201);
    const versionId = (await published.json()).data.version_id as string;

    // 编辑者：完整内容
    const asEditor = await jsonRequest(
      app,
      `/api/v1/problems/${paper.id}/versions/${versionId}`,
      { headers: auth },
    );
    const editorContent = (await asEditor.json()).data.content;
    assertEquals(editorContent.questions[0].answer, ["A"]);

    // 普通登录用户：答案与解析被裁剪（历史版本不能绕过答案保护）
    const { createUserToken } = await import("../../../../../tests/helper.ts");
    const viewer = await createUserToken("user");
    const asViewer = await jsonRequest(
      app,
      `/api/v1/problems/${paper.id}/versions/${versionId}`,
      { headers: { Authorization: `Bearer ${viewer}` } },
    );
    assertEquals(asViewer.status, 200);
    const viewerContent = (await asViewer.json()).data.content;
    assertEquals(viewerContent.questions[0].answer, []);
    assertEquals(viewerContent.questions[0].explanation, "");
    assertEquals(viewerContent.questions[0].prompt, "1+1=?");
  },
});

Deno.test({
  name: "problem versions route: 非编辑者读取草稿被拒（403）",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const problemId = await makeDraftProblem();
    const app = createApp();
    const { createUserToken } = await import("../../../../../tests/helper.ts");
    const viewer = await createUserToken("user");

    const res = await jsonRequest(app, `/api/v1/problems/${problemId}/draft`, {
      headers: { Authorization: `Bearer ${viewer}` },
    });
    assertEquals(res.status, 403);
  },
});
