/** 私有 LLM 题：管理员导入/发布、普通用户拒绝、题面与评测包保持私有。 */
import { assertEquals } from "jsr:@std/assert@^1";
import { zipSync } from "fflate";
import { and, eq } from "drizzle-orm";
import { createApp } from "../../../../app.ts";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { permissions, rolePermissions } from "../../../../shared/db/schema.ts";
import { createUserToken, jsonRequest } from "../../../../../tests/helper.ts";
import { getDefaultLlmLimits } from "../../../gateway/index.ts";

const runtime = {
  evaluator: {
    image: "noj-evaluator-python",
    command: "python3 /workspace/evaluate.py",
    time_limit_ms: 5000,
    memory_limit_mb: 256,
    network: { enabled: true },
  },
  solution: {
    image: "noj-solution-python",
    call_timeout_ms: 2000,
    memory_limit_mb: 256,
  },
};

function bundle(enableLlm = true): FormData {
  const enc = new TextEncoder();
  const zipped = zipSync({
    "problem.json": enc.encode(JSON.stringify({
      format_version: 1,
      title: "私有 LLM 回归",
      type: "U",
      runtime_config: runtime,
      ...(enableLlm ? { llm: { max_calls: 2 } } : {}),
    })),
    "statement.md": enc.encode("私有题面"),
    "evaluate.py": enc.encode("print('test')"),
    "visible.jsonl": enc.encode("{}\n"),
    "hidden.jsonl": enc.encode("{}\n"),
  });
  const form = new FormData();
  form.set(
    "file",
    new Blob([zipped as Uint8Array<ArrayBuffer>], { type: "application/zip" }),
    "private.zip",
  );
  form.set("publish", "true");
  return form;
}

Deno.test({
  name: "private LLM: 管理员私有导入发布及 CRUD/草稿准入均保留安全边界",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const admin = await createUserToken("admin");
    const user = await createUserToken("user");
    // 即使普通角色获得联网权限，也不能借 U 型题启用平台付费模型。
    const [network] = await getDb().select({ id: permissions.id }).from(
      permissions,
    ).where(
      and(
        eq(permissions.resource, "problem"),
        eq(permissions.action, "field_evaluator_network"),
      ),
    );
    await getDb().insert(rolePermissions).values({
      role_id: "user",
      permission_id: network.id,
    }).onConflictDoNothing();
    const app = createApp();
    const imported = await app.request("/api/v1/problems/import-bundle", {
      method: "POST",
      headers: { Authorization: `Bearer ${admin}` },
      body: bundle(),
    });
    assertEquals(imported.status, 200, await imported.clone().text());
    const { data: problem } = await imported.json();
    assertEquals(problem.type, "U");
    assertEquals(problem.visibility, "private");
    assertEquals(problem.published.version, 1);
    for (const suffix of ["", "/support-package", "/stats/public"]) {
      const res = await jsonRequest(
        app,
        `/api/v1/problems/${problem.id}${suffix}`,
        { token: user },
      );
      assertEquals(res.status, suffix === "/support-package" ? 403 : 404);
    }
    assertEquals(
      (await app.request(`/api/v1/problems/${problem.id}`)).status,
      404,
    );
    const denied = await app.request("/api/v1/problems/import-bundle", {
      method: "POST",
      headers: { Authorization: `Bearer ${user}` },
      body: bundle(),
    });
    assertEquals(denied.status, 403);
    assertEquals((await denied.json()).error.includes("仅管理员"), true);

    const createDenied = await jsonRequest(app, "/api/v1/problems", {
      token: user,
      method: "POST",
      body: {
        title: "普通用户的 LLM 题",
        description: "d",
        type: "U",
        runtime_config: runtime,
        llm: {},
      },
    });
    assertEquals(createDenied.status, 403, await createDenied.clone().text());
    const created = await app.request("/api/v1/problems/import-bundle", {
      method: "POST",
      headers: { Authorization: `Bearer ${user}` },
      body: bundle(false),
    });
    assertEquals(created.status, 200, await created.clone().text());
    const { data: owned } = await created.json();
    const draftResponse = await jsonRequest(
      app,
      `/api/v1/problems/${owned.id}/draft`,
      { token: user },
    );
    const { data: draft } = await draftResponse.json();
    const withLlm = { ...draft.content, llm_config: { max_calls: 2 } };
    const draftDenied = await jsonRequest(
      app,
      `/api/v1/problems/${owned.id}/draft`,
      {
        token: user,
        method: "PUT",
        body: { content: withLlm, expected_revision: draft.revision },
      },
    );
    assertEquals(draftDenied.status, 403);
    const updateDenied = await jsonRequest(
      app,
      `/api/v1/problems/${owned.id}`,
      {
        token: user,
        method: "PUT",
        body: { llm: { max_calls: 2 }, expected_revision: draft.revision },
      },
    );
    assertEquals(updateDenied.status, 403, await updateDenied.clone().text());
    const adminDraft = await jsonRequest(
      app,
      `/api/v1/problems/${owned.id}/draft`,
      {
        token: admin,
        method: "PUT",
        body: { content: withLlm, expected_revision: draft.revision },
      },
    );
    assertEquals(adminDraft.status, 200, await adminDraft.clone().text());
    const { data: saved } = await adminDraft.json();
    const publishingDenied = await jsonRequest(
      app,
      `/api/v1/problems/${owned.id}/versions`,
      {
        token: user,
        method: "POST",
        body: { expected_revision: saved.revision },
      },
    );
    assertEquals(
      publishingDenied.status,
      403,
      await publishingDenied.clone().text(),
    );
    const overBudget = await jsonRequest(app, "/api/v1/problems", {
      token: admin,
      method: "POST",
      body: {
        title: "U 型预算限制",
        description: "d",
        type: "U",
        runtime_config: runtime,
        llm: { max_tokens: getDefaultLlmLimits().max_tokens + 1 },
      },
    });
    assertEquals(overBudget.status, 400);
    const noNetwork = await jsonRequest(app, "/api/v1/problems", {
      token: admin,
      method: "POST",
      body: {
        title: "U 型联网限制",
        description: "d",
        type: "U",
        llm: {},
        runtime_config: {
          ...runtime,
          evaluator: { ...runtime.evaluator, network: { enabled: false } },
        },
      },
    });
    assertEquals(noNetwork.status, 400);
  },
});
