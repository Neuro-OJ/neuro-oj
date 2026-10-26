import { assertEquals } from "jsr:@std/assert@^1";
import { createApp } from "../../../../app.ts";
import {
  createUserToken,
  initRedisForTest,
  jsonRequest,
} from "../../../../../tests/helper.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import { resetDbForTest } from "../../../../../tests/helpers/db.ts";
import { problemTags, tags } from "../../../../shared/db/schema.ts";
import { verifyToken } from "../../../access/identity/index.ts";
import {
  consumeDomainInvitation,
  createDomain,
  createDomainInvitation,
  ensureDefaultWorkspace,
} from "../../../access/workspace/index.ts";
import { updateSetting } from "../../../platform/system/index.ts";
import { domainProblemsRouter } from "../../routes/domain-problems.ts";

async function fixture() {
  await resetDbForTest();
  await initRedisForTest();
  const token = await createUserToken("user");
  const actor = await verifyToken(token);
  await ensureDefaultWorkspace();
  await updateSetting("domain_creation_policy", "open", "0");
  const domain = await createDomain({
    slug: "api-school",
    name: "学校",
    preset: "education",
  }, actor.sub);
  // 测试组合根显式挂载，生产入口在资源隔离阶段完成后一起开放。
  const app = createApp();
  app.route("/api/v1", domainProblemsRouter);
  return { token, domain, app };
}

Deno.test({
  name: "域题库 API: 创建及未发布草稿编辑复用域授权和 revision",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { token, app } = await fixture();
    const path = "/api/v1/domains/api-school/problems";
    const created = await jsonRequest(app, path, {
      token,
      method: "POST",
      body: { title: "套卷", description: "草稿", is_objective: true },
    });
    assertEquals(created.status, 201);
    const identity = await created.json();
    assertEquals(identity.display_ref, "1001");
    assertEquals("type" in identity, false);
    const draftPath = `${path}/1001/draft`;
    const read = await jsonRequest(app, draftPath, { token });
    assertEquals(read.status, 200);
    assertEquals(read.headers.get("cache-control"), "no-store");
    const draft = await read.json();
    assertEquals(draft.revision, 1);
    assertEquals(
      (await jsonRequest(app, `${path}/1001`, { token })).status,
      404,
    );
    const content = { ...draft.content, title: "修改后的套卷" };
    assertEquals(
      (await jsonRequest(app, draftPath, {
        token,
        method: "PUT",
        body: { content },
      })).status,
      428,
    );
    const updated = await jsonRequest(app, draftPath, {
      token,
      method: "PUT",
      headers: { "If-Match": "1" },
      body: { content },
    });
    assertEquals(updated.status, 200);
    assertEquals((await updated.json()).revision, 2);
    assertEquals(
      (await jsonRequest(app, draftPath, {
        token,
        method: "PUT",
        headers: { "If-Match": "1" },
        body: { content },
      })).status,
      409,
    );
    const completed = {
      ...content,
      questions: [{
        key: "sum",
        sort_order: 0,
        type: "single",
        prompt: "1+1=?",
        options: [{ key: "A", text: "2" }, { key: "B", text: "3" }],
        answer: ["A"],
        explanation: "整数加法",
      }],
    };
    assertEquals(
      (await jsonRequest(app, draftPath, {
        token,
        method: "PUT",
        headers: { "If-Match": "2" },
        body: { content: completed },
      })).status,
      200,
    );
    const published = await jsonRequest(app, `${path}/1001/publish`, {
      token,
      method: "POST",
      headers: { "If-Match": "3" },
      body: { change_note: "首次发布" },
    });
    assertEquals(published.status, 200);
    assertEquals((await published.json()).version, 1);
    const page = await jsonRequest(app, `${path}?limit=1`, { token });
    assertEquals((await page.json()).total, 1);
    const summaries = await jsonRequest(
      app,
      "/api/v1/domains/api-school/problem-summaries",
      { token, method: "POST", body: { references: ["1001", "9999"] } },
    );
    assertEquals(summaries.status, 200);
    const summaryBody = await summaries.json();
    assertEquals(summaryBody.data.items.length, 2);
    assertEquals(summaryBody.data.items[0].reference, "1001");
    assertEquals(summaryBody.data.items[0].availability, "available");
    assertEquals(summaryBody.data.items[0].title, "修改后的套卷");
    assertEquals(summaryBody.data.items[0].kind, "objective");
    assertEquals(summaryBody.data.items[0].answer_version, 1);
    assertEquals(typeof summaryBody.data.items[0].answer_version_id, "string");
    assertEquals(summaryBody.data.items[0].progress, "unseen");
    assertEquals(summaryBody.data.items[1], {
      reference: "9999",
      availability: "unavailable",
      title: null,
      kind: null,
      answer_version_id: null,
      answer_version: null,
      progress: null,
    });
    assertEquals(
      (await jsonRequest(app, "/api/v1/domains/api-school/problem-summaries", {
        token,
        method: "POST",
        body: { references: Array(51).fill("1001") },
      })).status,
      400,
    );
    const studentToken = await createUserToken("user");
    const student = await verifyToken(studentToken);
    const teacher = await verifyToken(token);
    const topicId = crypto.randomUUID(), algorithmId = crypto.randomUUID();
    const now = new Date().toISOString();
    await getDb().insert(tags).values([
      {
        id: topicId,
        name: "基础题",
        kind: "problem",
        created_at: now,
        updated_at: now,
      },
      {
        id: algorithmId,
        name: "隐藏算法",
        kind: "algorithm",
        created_at: now,
        updated_at: now,
      },
    ]);
    await getDb().insert(problemTags).values([
      { problem_id: identity.problem_id, tag_id: topicId },
      { problem_id: identity.problem_id, tag_id: algorithmId },
    ]);
    const invitation = await createDomainInvitation(
      "api-school",
      teacher.sub,
      `${student.sub}@test.local`,
    );
    await consumeDomainInvitation(invitation.token, student.sub);
    const studentView = await jsonRequest(app, `${path}/1001`, {
      token: studentToken,
    });
    assertEquals(studentView.status, 200);
    const detail = await studentView.json();
    assertEquals(detail.can_edit, false);
    assertEquals(detail.content.questions[0].answer, []);
    assertEquals(detail.owner.id, teacher.sub);
    assertEquals(Object.keys(detail.owner).sort(), [
      "avatar_url",
      "id",
      "username",
    ]);
    assertEquals(detail.tags.map((tag: { id: string }) => tag.id), [topicId]);
    assertEquals(detail.has_hidden_algorithm_tags, true);
    const authorView = await (await jsonRequest(app, `${path}/1001`, { token }))
      .json();
    assertEquals(authorView.tags.length, 2);
    assertEquals(authorView.has_hidden_algorithm_tags, false);
    assertEquals(
      (await jsonRequest(app, draftPath, { token: studentToken })).status,
      403,
    );
  },
});

Deno.test({
  name: "域题库 API: 外域路径、普通账号和旧分类不能取得写入权限",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { token, app } = await fixture();
    const path = "/api/v1/domains/api-school/problems";
    const body = { title: "套卷", description: "测试", is_objective: true };
    assertEquals(
      (await jsonRequest(app, path, { method: "POST", body })).status,
      401,
    );
    assertEquals(
      (await jsonRequest(app, path, {
        token,
        method: "POST",
        body: { ...body, type: "P" },
      })).status,
      400,
    );
    const stranger = await createUserToken("user");
    assertEquals(
      (await jsonRequest(app, path, { token: stranger, method: "POST", body }))
        .status,
      404,
    );
    assertEquals(
      (await jsonRequest(
        app,
        "/api/v1/domains/main/problems/api-school:1001/draft",
        { token },
      )).status,
      404,
    );
    const malformed = await jsonRequest(app, path, {
      token,
      method: "POST",
      body: null,
    });
    assertEquals(malformed.status, 400);
  },
});
