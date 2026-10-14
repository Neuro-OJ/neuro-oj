/**
 * 题目草稿与版本路由测试（Handbook §4.1、§5.2、§5.3）。
 *
 * 覆盖：编辑者读取派生草稿、乐观锁 428/409、发布预检、发布新版本、
 * 相同内容重复发布（unchanged）、版本列表与指定版本读取（非编辑者答案裁剪）、
 * 非编辑者访问草稿被拒。
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { AppError } from "../../../../shared/base/errors.ts";
import { initRedisForTest } from "../../../../../tests/helper.ts";
import { createApp } from "../../../../app.ts";
import { createProblem } from "../../index.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  problemBindingHistory,
  problemDrafts,
  problems,
  problemVersions,
} from "../../../../shared/db/schema.ts";
import { eq } from "drizzle-orm";
import {
  deleteProblemFixtures,
  jsonRequest,
} from "../../../../../tests/helper.ts";

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

/** 建一道默认域题目，内容完整，仅用于草稿与版本接口。 */
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

/** 管理员凭据通过实际平台治理权限编辑他人题目。 */
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
  name: "problem versions route: 创建即建草稿（revision=1，非派生）",
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
    // 创建即写入草稿行（Handbook §6.2），编辑者拿到的是真实 revision 而非派生初值
    assertEquals(body.data.revision, 1);
    assertEquals(body.data.synthesized, false);
    assertEquals(body.data.content.kind, "ai");
    assertEquals(body.data.content.title.length > 0, true);
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

    // 正确 revision（创建后的 1）→ 写入成功并递增
    const saved = await jsonRequest(app, url, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "If-Match": "1" },
      body: { content: draftContent("改后题面") },
    });
    assertEquals(saved.status, 200);
    const savedBody = await saved.json();
    assertEquals(savedBody.data.revision, 2);
    assertEquals(savedBody.data.content.title, "改后题面");

    // 过时 revision → 409
    const stale = await jsonRequest(app, url, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "If-Match": "1" },
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
      headers: { ...auth, "If-Match": "1" },
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
    assertEquals(report.data.revision, 2);

    // 发布 V1
    const published = await jsonRequest(
      app,
      `/api/v1/problems/${problemId}/versions`,
      {
        method: "POST",
        headers: { ...auth, "If-Match": "2" },
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
      headers: { ...auth, "If-Match": "1" },
      body: { content },
    });
    assertEquals(saved.status, 200);

    const published = await jsonRequest(
      app,
      `/api/v1/problems/${paper.id}/versions`,
      {
        method: "POST",
        headers: { ...auth, "If-Match": "2" },
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

Deno.test({
  name: "problem versions route: 有版本的源题拒绝物理删除并保留草稿及版本",
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
      headers: { ...auth, "If-Match": "1" },
      body: { content: draftContent("待删题面") },
    });
    const published = await jsonRequest(
      app,
      `/api/v1/problems/${problemId}/versions`,
      {
        method: "POST",
        headers: { ...auth, "If-Match": "2" },
        body: { change_note: "V1" },
      },
    );
    assertEquals(published.status, 201);

    const db = getDb();
    const { deleteProblem, getProblemDraft } = await import("../../index.ts");
    const error = await assertRejects(
      () => deleteProblem(problemId, undefined, "admin"),
      AppError,
    );
    assertEquals(error.statusCode, 409);
    assertEquals(error.code, "SOURCE_HAS_RETAINED_REFERENCES");

    const [problemRow] = await db.select().from(problems).where(
      eq(problems.id, problemId),
    );
    assertEquals(problemRow.id, problemId);
    const versionRows = await db.select().from(problemVersions).where(
      eq(problemVersions.problem_id, problemId),
    );
    assertEquals(versionRows.length, 1);
    const draftRows = await db.select().from(problemDrafts).where(
      eq(problemDrafts.problem_id, problemId),
    );
    assertEquals(draftRows.length, 1);
    assertEquals((await getProblemDraft(problemId)).problem_id, problemId);
  },
});

Deno.test({
  name:
    "problem versions route: 详情返回默认作答版本，?version_id 显式读取历史版本",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const problemId = await makeDraftProblem();
    const app = createApp();
    const token = await adminToken();
    const auth = { Authorization: `Bearer ${token}` };

    // V1
    await jsonRequest(app, `/api/v1/problems/${problemId}/draft`, {
      method: "PUT",
      headers: { ...auth, "If-Match": "1" },
      body: { content: draftContent("V1 题面") },
    });
    const v1 = await jsonRequest(
      app,
      `/api/v1/problems/${problemId}/versions`,
      {
        method: "POST",
        headers: { ...auth, "If-Match": "2" },
        body: { change_note: "V1" },
      },
    );
    const v1Id = (await v1.json()).data.version_id as string;

    // V2
    await jsonRequest(app, `/api/v1/problems/${problemId}/draft`, {
      method: "PUT",
      headers: { ...auth, "If-Match": "3" },
      body: { content: draftContent("V2 题面") },
    });
    const v2 = await jsonRequest(
      app,
      `/api/v1/problems/${problemId}/versions`,
      {
        method: "POST",
        headers: { ...auth, "If-Match": "4" },
        body: { change_note: "V2" },
      },
    );
    const v2Id = (await v2.json()).data.version_id as string;

    // 默认（any 策略）→ 最新版 V2
    const detail = await jsonRequest(app, `/api/v1/problems/${problemId}`, {
      headers: auth,
    });
    assertEquals(detail.status, 200);
    const detailBody = (await detail.json()).data;
    assertEquals(detailBody.version_id, v2Id);
    assertEquals(detailBody.version, 2);
    assertEquals(detailBody.latest_version_id, v2Id);
    assertEquals(detailBody.latest_version, 2);
    assertEquals(detailBody.is_latest, true);
    assertEquals(detailBody.effective_version_policy, { mode: "any" });
    assertEquals(detailBody.title, "V2 题面");

    // 显式读取历史版本 V1：内容切换为 V1，且标记非最新
    const asV1 = await jsonRequest(
      app,
      `/api/v1/problems/${problemId}?version_id=${v1Id}`,
      { headers: auth },
    );
    assertEquals(asV1.status, 200);
    const v1Body = (await asV1.json()).data;
    assertEquals(v1Body.version_id, v1Id);
    assertEquals(v1Body.version, 1);
    assertEquals(v1Body.is_latest, false);
    assertEquals(v1Body.latest_version, 2);
    assertEquals(v1Body.title, "V1 题面");
    // 管理信息（难度/可见性）沿用当前值，不随版本回退
    assertEquals(v1Body.difficulty, detailBody.difficulty);
  },
});

Deno.test({
  name: "problem versions route: 未发布题目对普通访问者 404，编辑者可读",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const { createUserToken } = await import("../../../../../tests/helper.ts");
    // admin：既验证"编辑者仍可读取草稿题"，也避免依赖 U 型题的 owner 关系
    const editorToken = await createUserToken("admin");
    const problemId = await makeDraftProblem();

    // 尚未发布任何版本：匿名访问者一律 404（不泄露草稿题面存在性）
    const anonymous = await jsonRequest(app, `/api/v1/problems/${problemId}`);
    assertEquals(anonymous.status, 404);

    // 编辑者仍可读取（编辑入口依赖的路径），并明确看到"尚无最新版"
    const editorRead = await jsonRequest(app, `/api/v1/problems/${problemId}`, {
      token: editorToken,
    });
    assertEquals(editorRead.status, 200);
    assertEquals((await editorRead.json()).data.latest_version_id, null);

    // 发布 V1 并转为公开后对匿名访问者开放
    const draft = await jsonRequest(
      app,
      `/api/v1/problems/${problemId}/draft`,
      { token: editorToken },
    );
    assertEquals(draft.status, 200);
    const revision = (await draft.json()).data.revision as number;
    const published = await jsonRequest(
      app,
      `/api/v1/problems/${problemId}/versions`,
      {
        method: "POST",
        token: editorToken,
        headers: { "If-Match": String(revision) },
        body: { change_note: "首个版本" },
      },
    );
    assertEquals(published.status, 201);
    const versionId = (await published.json()).data.version_id as string;
    assertEquals(typeof versionId, "string");
    await getDb().update(problems).set({ visibility: "public" }).where(
      eq(problems.id, problemId),
    );

    const anonymousAfter = await jsonRequest(
      app,
      `/api/v1/problems/${problemId}`,
    );
    assertEquals(anonymousAfter.status, 200);
    const afterBody = (await anonymousAfter.json()).data;
    assertEquals(afterBody.version_id, versionId);
    assertEquals(afterBody.latest_version, 1);

    // 隔离测试清理先移除绑定沿革引用，再清除草稿、指针和版本。
    await getDb().delete(problemBindingHistory).where(
      eq(problemBindingHistory.problem_id, problemId),
    );
    await getDb().delete(problemDrafts).where(
      eq(problemDrafts.problem_id, problemId),
    );
    await getDb().update(problems).set({
      latest_version_id: null,
      required_version_id: null,
    }).where(eq(problems.id, problemId));
    await getDb().delete(problemVersions).where(
      eq(problemVersions.problem_id, problemId),
    );
  },
});

Deno.test({
  name: "problem versions route: 公共列表排除未发布题目，发布后纳入",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const { publishBaselineVersionForTest } = await import(
      "../../../../../tests/helper.ts"
    );
    // 显式公开题（无已发布版本），不能依赖已移除的题库分类决定可见性。
    const problemId = crypto.randomUUID();
    const now = new Date().toISOString();
    await getDb().insert(problems).values({
      domain_id: "00000000-0000-4000-8000-000000000001",
      id: problemId,
      title: `未发布列表题 ${ts}`,
      description: "草稿题面",
      difficulty: "easy",
      visibility: "public",
      number: 8900000 + (ts % 10000),
      owner_id: "0",
      created_at: now,
      updated_at: now,
    });

    const listBefore = await jsonRequest(app, "/api/v1/problems?per_page=100");
    assertEquals(listBefore.status, 200);
    const idsBefore = (await listBefore.json()).data.map(
      (item: { id: string }) => item.id,
    );
    assertEquals(idsBefore.includes(problemId), false);

    // 发布基线版本（存量题目的既有形态）后进入公共列表
    await publishBaselineVersionForTest(problemId);
    const listAfter = await jsonRequest(app, "/api/v1/problems?per_page=100");
    const idsAfter = (await listAfter.json()).data.map(
      (item: { id: string }) => item.id,
    );
    assertEquals(idsAfter.includes(problemId), true);

    await getDb().update(problems).set({
      latest_version_id: null,
      required_version_id: null,
    }).where(eq(problems.id, problemId));
    await getDb().delete(problemVersions).where(
      eq(problemVersions.problem_id, problemId),
    );
    await deleteProblemFixtures(eq(problems.id, problemId));
  },
});

Deno.test({
  name:
    "problem versions route: 已发布题目的内容更新只进草稿、管理信息立即生效（批次 2e）",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const problemId = await makeDraftProblem();
    const app = createApp();
    const token = await adminToken();
    const auth = { Authorization: `Bearer ${token}` };

    // 草稿（revision 1，创建即建）→ 发布 V1（revision 2）
    await jsonRequest(app, `/api/v1/problems/${problemId}/draft`, {
      method: "PUT",
      headers: { ...auth, "If-Match": "1" },
      body: { content: draftContent("V1 题面") },
    });
    const v1 = await jsonRequest(
      app,
      `/api/v1/problems/${problemId}/versions`,
      {
        method: "POST",
        headers: { ...auth, "If-Match": "2" },
        body: { change_note: "V1" },
      },
    );
    assertEquals(v1.status, 201);
    const v1Id = (await v1.json()).data.version_id as string;

    // 已发布：内容 + 管理信息一起 PUT
    const updated = await jsonRequest(app, `/api/v1/problems/${problemId}`, {
      method: "PUT",
      headers: { ...auth, "If-Match": "3" },
      body: {
        title: "草稿标题",
        description: "草稿题面",
        difficulty: "hard",
        runtime_config: runtimeConfig,
      },
    });
    assertEquals(updated.status, 200);
    const updatedBody = (await updated.json()).data;
    // 管理信息立即生效；考试内容投影保持 V1（只有发布才更新）
    assertEquals(updatedBody.difficulty, "hard");
    assertEquals(updatedBody.title, "V1 题面");

    const draft = await jsonRequest(
      app,
      `/api/v1/problems/${problemId}/draft`,
      {
        headers: auth,
      },
    );
    const draftBody = (await draft.json()).data;
    assertEquals(draftBody.content.title, "草稿标题");
    assertEquals(draftBody.content.description, "草稿题面");
    // 发布后 revision 3，内容保存再 +1
    assertEquals(draftBody.revision, 4);

    // 作答内容仍是 V1
    const detail = await jsonRequest(app, `/api/v1/problems/${problemId}`, {
      headers: auth,
    });
    const detailBody = (await detail.json()).data;
    assertEquals(detailBody.version_id, v1Id);
    assertEquals(detailBody.title, "V1 题面");

    // 显式发布 → 投影与版本内容才更新
    const v2 = await jsonRequest(
      app,
      `/api/v1/problems/${problemId}/versions`,
      {
        method: "POST",
        headers: { ...auth, "If-Match": "4" },
        body: { change_note: "V2" },
      },
    );
    assertEquals(v2.status, 201);
    const detail2 = await jsonRequest(app, `/api/v1/problems/${problemId}`, {
      headers: auth,
    });
    const detailBody2 = (await detail2.json()).data;
    assertEquals(detailBody2.version, 2);
    assertEquals(detailBody2.title, "草稿标题");
    assertEquals(detailBody2.difficulty, "hard");
  },
});

Deno.test({
  name: "problem versions route: 未发布内容仅保存草稿，不修改题目投影",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const problemId = await makeDraftProblem();
    const app = createApp();
    const token = await adminToken();
    const auth = { Authorization: `Bearer ${token}` };

    const updated = await jsonRequest(app, `/api/v1/problems/${problemId}`, {
      method: "PUT",
      headers: { ...auth, "If-Match": "1" },
      body: { title: "未发布新标题", description: "未发布新题面" },
    });
    assertEquals(updated.status, 200);
    const identity = (await updated.json()).data;
    assertEquals(identity.title === "未发布新标题", false);

    const draft = await jsonRequest(
      app,
      `/api/v1/problems/${problemId}/draft`,
      {
        headers: auth,
      },
    );
    const draftBody = (await draft.json()).data;
    assertEquals(draftBody.content.title, "未发布新标题");
    assertEquals(draftBody.revision, 2);
  },
});

Deno.test({
  name:
    "problem versions route: exact 策略下默认详情内容与版本号一致（#2 默认/竞赛口径统一）",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const problemId = await makeDraftProblem();
    const app = createApp();
    const token = await adminToken();
    const auth = { Authorization: `Bearer ${token}` };

    // V1：题面与评测命令都与 V2 明显不同
    const v1Content = {
      ...draftContent("V1 题面"),
      runtime_config: {
        ...runtimeConfig,
        evaluator: {
          ...runtimeConfig.evaluator,
          command: "python3 /workspace/v1.py",
        },
      },
    };
    await jsonRequest(app, `/api/v1/problems/${problemId}/draft`, {
      method: "PUT",
      headers: { ...auth, "If-Match": "1" },
      body: { content: v1Content },
    });
    const v1 = await jsonRequest(
      app,
      `/api/v1/problems/${problemId}/versions`,
      {
        method: "POST",
        headers: { ...auth, "If-Match": "2" },
        body: { change_note: "V1" },
      },
    );
    const v1Id = (await v1.json()).data.version_id as string;

    // V2：最新版
    const v2Content = {
      ...draftContent("V2 题面"),
      runtime_config: {
        ...runtimeConfig,
        evaluator: {
          ...runtimeConfig.evaluator,
          command: "python3 /workspace/v2.py",
        },
      },
      template_content: "print('v2')",
    };
    await jsonRequest(app, `/api/v1/problems/${problemId}/draft`, {
      method: "PUT",
      headers: { ...auth, "If-Match": "3" },
      body: { content: v2Content },
    });
    await jsonRequest(app, `/api/v1/problems/${problemId}/versions`, {
      method: "POST",
      headers: { ...auth, "If-Match": "4" },
      body: { change_note: "V2" },
    });

    // 题库策略切到 exact(V1)
    const policy = await jsonRequest(
      app,
      `/api/v1/admin/problems/${problemId}/effective-version-policy`,
      {
        method: "PUT",
        headers: auth,
        body: {
          policy: { mode: "exact", version_id: v1Id },
          expected_revision:
            (await jsonRequest(app, `/api/v1/problems/${problemId}`, {
              headers: auth,
            }).then((response) => response.json())).data
              .effective_version_policy_revision,
        },
      },
    );
    assertEquals(policy.status, 200);

    // 默认详情必须回答 V1：版本号、题面、评测命令三者一致（内容不能来自 V2 投影）
    const detail = await jsonRequest(app, `/api/v1/problems/${problemId}`, {
      headers: auth,
    });
    assertEquals(detail.status, 200);
    const body = (await detail.json()).data;
    assertEquals(body.version_id, v1Id);
    assertEquals(body.version, 1);
    assertEquals(body.is_latest, false);
    assertEquals(body.latest_version, 2);
    assertEquals(body.effective_version_policy.mode, "exact");
    assertEquals(body.title, "V1 题面");
    assertEquals(
      body.runtime_config.evaluator.command,
      "python3 /workspace/v1.py",
    );

    // 编辑者读草稿仍是 V2 编辑态（内容事实源分离）
    const draft = await jsonRequest(
      app,
      `/api/v1/problems/${problemId}/draft`,
      { headers: auth },
    );
    assertEquals((await draft.json()).data.content.title, "V2 题面");
  },
});

Deno.test({
  name:
    "problem versions route: 非编辑者读历史版本不下发评测配置/模板（#5 按字段裁剪）",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // 公开题：非 owner 的普通用户也能读
    const created = await createProblem({
      title: `公开版本裁剪题 ${ts}_${Math.random().toString(36).slice(2, 8)}`,
      description: "初始题面",
      difficulty: "easy",
      samples: [],
      runtime_config: runtimeConfig,
      visibility: "public",
    });
    const problemId = created.id;
    const app = createApp();
    const admin = await adminToken();
    const adminAuth = { Authorization: `Bearer ${admin}` };
    const { createUserToken } = await import("../../../../../tests/helper.ts");
    const userToken = await createUserToken("user");
    const userAuth = { Authorization: `Bearer ${userToken}` };

    await jsonRequest(app, `/api/v1/problems/${problemId}/draft`, {
      method: "PUT",
      headers: { ...adminAuth, "If-Match": "1" },
      body: {
        content: {
          ...draftContent("带敏感配置的题面"),
          template_content: "print('secret-template')",
        },
      },
    });
    const published = await jsonRequest(
      app,
      `/api/v1/problems/${problemId}/versions`,
      {
        method: "POST",
        headers: { ...adminAuth, "If-Match": "2" },
        body: { change_note: "V1" },
      },
    );
    const v1Id = (await published.json()).data.version_id as string;

    // 普通用户：默认详情与版本内容接口都必须裁剪 runtime_config / 模板
    const userDetail = await jsonRequest(
      app,
      `/api/v1/problems/${problemId}`,
      { headers: userAuth },
    );
    assertEquals(userDetail.status, 200);
    const userBody = (await userDetail.json()).data;
    assertEquals(userBody.runtime_config, undefined);
    assertEquals(userBody.template_content, undefined);
    assertEquals(userBody.support_package_storage_url, undefined);
    assertEquals(userBody.title, "带敏感配置的题面");

    const userVersion = await jsonRequest(
      app,
      `/api/v1/problems/${problemId}/versions/${v1Id}`,
      { headers: userAuth },
    );
    assertEquals(userVersion.status, 200);
    const userVersionContent = (await userVersion.json()).data.content;
    assertEquals(userVersionContent.runtime_config, undefined);
    assertEquals(userVersionContent.template_content, undefined);

    // 编辑者（admin）全量可见
    const adminDetail = await jsonRequest(
      app,
      `/api/v1/problems/${problemId}`,
      { headers: adminAuth },
    );
    const adminBody = (await adminDetail.json()).data;
    assertEquals(
      adminBody.runtime_config.evaluator.command,
      "python3 /workspace/evaluate.py",
    );
    assertEquals(adminBody.template_content, "print('secret-template')");

    const adminVersion = await jsonRequest(
      app,
      `/api/v1/problems/${problemId}/versions/${v1Id}`,
      { headers: adminAuth },
    );
    const adminVersionContent = (await adminVersion.json()).data.content;
    assertEquals(
      adminVersionContent.runtime_config.evaluator.command,
      "python3 /workspace/evaluate.py",
    );
  },
});

import { resetDbForTest } from "../default-fixture.ts";
