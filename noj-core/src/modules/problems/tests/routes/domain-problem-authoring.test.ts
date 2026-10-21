import { assertEquals } from "jsr:@std/assert@^1";
import { zipSync } from "fflate";
import { eq, sql } from "drizzle-orm";
import { createApp } from "../../../../app.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import { resetDbForTest } from "../../../../../tests/helpers/db.ts";
import {
  domains,
  permissions,
  rolePermissions,
  roles,
  userRoles,
} from "../../../../shared/db/schema.ts";
import {
  createUserToken,
  initRedisForTest,
  jsonRequest,
} from "../../../../../tests/helper.ts";
import { verifyToken } from "../../../access/identity/index.ts";
import {
  createDomain,
  ensureDefaultWorkspace,
} from "../../../access/workspace/index.ts";
import {
  resetStorageProvider,
  setStorageProviderForTest,
  updateSetting,
} from "../../../platform/system/index.ts";
import { LocalStorageProvider } from "../../../platform/system/index.ts";
import { domainProblemsRouter } from "../../routes/domain-problems.ts";

const runtime = {
  backend: "native",
  languages: ["cc"],
  time_limit_ms: 1000,
  memory_limit_mb: 256,
  checker: { type: "default" },
  subtasks: [{
    id: "sum",
    score: 100,
    cases: [{ input: "1.in", output: "1.out" }],
  }],
};

async function fixture() {
  await resetDbForTest();
  await initRedisForTest();
  const token = await createUserToken("user"), actor = await verifyToken(token);
  await ensureDefaultWorkspace();
  await updateSetting("domain_creation_policy", "open", "0");
  await createDomain({
    slug: "author-school",
    name: "学校",
    preset: "education",
  }, actor.sub);
  const app = createApp();
  app.route("/api/v1", domainProblemsRouter);
  return {
    app,
    token,
    actor,
    prefix: "/api/v1/domains/author-school/problems",
  };
}

Deno.test({
  name: "域出题: 未发布源题找回、OI文件保存预检发布与外域拒绝形成闭环",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { app, token, prefix } = await fixture();
    const directory = await Deno.makeTempDir({
      prefix: "noj-domain-oi-author-",
    });
    setStorageProviderForTest(new LocalStorageProvider(directory));
    try {
      const created = await jsonRequest(app, prefix, {
        token,
        method: "POST",
        body: {
          title: "加法",
          description: "输出和",
          judge_type: "oi",
          runtime_config: runtime,
        },
      });
      assertEquals(created.status, 201);
      const identity = await created.json();
      const drafts = await jsonRequest(
        app,
        "/api/v1/domains/author-school/problem-drafts",
        { token },
      );
      const catalog = await drafts.json();
      assertEquals(catalog.total, 1);
      assertEquals(catalog.items[0].reference.number, identity.number);
      assertEquals(catalog.items[0].draft_revision, 1);
      assertEquals(
        (await jsonRequest(app, `${prefix}/${identity.number}`, { token }))
          .status,
        404,
      );
      const path = `${prefix}/${identity.number}`;
      const initial = await (await jsonRequest(app, `${path}/draft`, { token }))
        .json();
      const form = new FormData();
      form.set(
        "metadata",
        JSON.stringify({
          content: initial.content,
          upload_paths: ["1.in", "1.out"],
        }),
      );
      form.append("data_files", new File(["1 2\n"], "1.in"));
      form.append("data_files", new File(["3\n"], "1.out"));
      const save = await app.request(`${path}/oi/save`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "If-Match": "1" },
        body: form,
      });
      assertEquals(save.status, 200, await save.clone().text());
      assertEquals((await save.json()).data.draft_revision, 2);
      const listed =
        await (await jsonRequest(app, `${path}/oi/files`, { token })).json();
      assertEquals(listed.data.files, [{ path: "1.in", size: 4 }, {
        path: "1.out",
        size: 2,
      }]);
      const file =
        await (await jsonRequest(app, `${path}/oi/file?path=1.in`, { token }))
          .json();
      assertEquals(file.data.text, "1 2\n");
      const stranger = await createUserToken("user");
      assertEquals(
        (await jsonRequest(app, `${path}/oi/file?path=1.in&download=1`, {
          token: stranger,
        })).status,
        404,
      );
      assertEquals(
        (await jsonRequest(
          app,
          `/api/v1/domains/main/problems/${identity.number}/oi/files`,
          { token },
        )).status,
        404,
      );
      assertEquals(
        (await jsonRequest(app, `${path}/publish-preflight`, { token })).status,
        428,
      );
      assertEquals(
        (await jsonRequest(
          app,
          `${path}/publish-preflight?expected_revision=1`,
          { token },
        )).status,
        409,
      );
      const preflight = await (await jsonRequest(
        app,
        `${path}/publish-preflight?expected_revision=2`,
        { token },
      )).json();
      assertEquals(preflight.ready, true, JSON.stringify(preflight));
      const published = await jsonRequest(app, `${path}/publish`, {
        token,
        method: "POST",
        headers: { "If-Match": "2" },
        body: { change_note: "上传测试数据" },
      });
      assertEquals(published.status, 200, await published.clone().text());
      assertEquals((await jsonRequest(app, `${path}`, { token })).status, 200);
      const stale = await app.request(`${path}/oi/save`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "If-Match": "1" },
        body: form,
      });
      assertEquals(stale.status, 409);
    } finally {
      resetStorageProvider();
      await Deno.remove(directory, { recursive: true });
    }
  },
});

Deno.test({
  name: "域出题: ZIP替换未发布套卷草稿，不改路径编号或隐式发布并校验revision",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { app, token, prefix } = await fixture();
    const identity = await (await jsonRequest(app, prefix, {
      token,
      method: "POST",
      body: { title: "待导入", description: "待导入", is_objective: true },
    })).json();
    const encoder = new TextEncoder();
    const archive = zipSync({
      "problem.json": encoder.encode(
        JSON.stringify({
          format_version: 2,
          number: 9000,
          title: "整数套卷",
          is_objective: true,
        }),
      ),
      "statement.md": encoder.encode("整数加法"),
      "questions.json": encoder.encode(
        JSON.stringify([{
          key: "sum",
          type: "single",
          prompt: "1+2=?",
          options: [{ key: "A", text: "3" }],
          answer: ["A"],
        }]),
      ),
    });
    const path = `${prefix}/${identity.number}`;
    const form = new FormData();
    form.set("file", new File([archive as BlobPart], "paper.zip"));
    const upload = async (revision?: string) =>
      await app.request(`${path}/import-bundle`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          ...(revision === undefined ? {} : { "If-Match": revision }),
        },
        body: form,
      });
    assertEquals((await upload()).status, 428);
    const saved = await upload("1");
    assertEquals(saved.status, 200, await saved.clone().text());
    assertEquals((await saved.json()).data.draft_revision, 2);
    assertEquals((await upload("1")).status, 409);
    const draft = await (await jsonRequest(app, `${path}/draft`, { token }))
      .json();
    assertEquals(draft.content.title, "整数套卷");
    assertEquals(draft.content.questions[0].key, "sum");
    assertEquals((await jsonRequest(app, `${path}`, { token })).status, 404);
    const list = await (await jsonRequest(
      app,
      "/api/v1/domains/author-school/problem-drafts",
      { token },
    )).json();
    assertEquals(list.items[0].reference.number, identity.number);
  },
});

Deno.test({
  name: "域出题: 全包导入按域编号更新且创建草稿失败不留下身份和游标",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { app, token, prefix } = await fixture();
    const upload = async (title: string, revision?: string) => {
      const encoder = new TextEncoder();
      const archive = zipSync({
        "problem.json": encoder.encode(
          JSON.stringify({
            format_version: 2,
            number: 1001,
            title,
            is_objective: true,
          }),
        ),
        "statement.md": encoder.encode("题面"),
        "questions.json": encoder.encode(
          JSON.stringify([{
            key: "sum",
            type: "judge",
            prompt: "1+1=2",
            answer: [true],
          }]),
        ),
      });
      const form = new FormData();
      form.set("file", new File([archive as BlobPart], "paper.zip"));
      return await app.request(`${prefix}/import-bundle`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          ...(revision === undefined ? {} : { "If-Match": revision }),
        },
        body: form,
      });
    };
    const db = getDb();
    await db.execute(
      sql`ALTER TABLE problem_drafts ADD CONSTRAINT author_import_failure CHECK (content->>'title' <> 'reject-import')`,
    );
    try {
      assertEquals((await upload("reject-import")).status, 500);
      const [domain] = await db.select().from(domains).where(
        eq(domains.slug, "author-school"),
      );
      assertEquals(domain.next_problem_number, 1001);
      const drafts = await (await jsonRequest(
        app,
        "/api/v1/domains/author-school/problem-drafts",
        { token },
      )).json();
      assertEquals(drafts.total, 0);
    } finally {
      await db.execute(
        sql`ALTER TABLE problem_drafts DROP CONSTRAINT author_import_failure`,
      );
    }
    const created = await upload("新套卷");
    assertEquals(created.status, 201, await created.clone().text());
    const identity = (await created.json()).data;
    assertEquals(identity.number, 1001);
    assertEquals(identity.draft_revision, 1);
    assertEquals((await upload("更新套卷")).status, 428);
    const updated = await upload("更新套卷", "1");
    assertEquals(updated.status, 200, await updated.clone().text());
    assertEquals((await updated.json()).data.problem_id, identity.problem_id);
    const draft =
      await (await jsonRequest(app, `${prefix}/1001/draft`, { token })).json();
    assertEquals(draft.revision, 2);
    assertEquals(draft.content.title, "更新套卷");
    assertEquals(
      (await jsonRequest(app, `${prefix}/1001`, { token })).status,
      404,
    );
  },
});

Deno.test({
  name: "域出题: 普通域负责人经实例授予网络能力即可启用LLM，旧P/U不决定能力",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { app, token, actor, prefix } = await fixture();
    const config = {
      evaluator: {
        image: "noj-evaluator-python",
        command: "python3 /workspace/evaluate.py",
        time_limit_ms: 5000,
        memory_limit_mb: 512,
        network: { enabled: true },
      },
      solution: {
        image: "noj-solution-python",
        call_timeout_ms: 2000,
        memory_limit_mb: 512,
      },
    };
    const input = {
      title: "LLM能力题",
      description: "题面",
      runtime_config: config,
      llm: { max_calls: 1 },
    };
    assertEquals(
      (await jsonRequest(app, prefix, { token, method: "POST", body: input }))
        .status,
      403,
    );
    const db = getDb();
    const [permission] = await db.select().from(permissions).where(
      eq(permissions.resource, "problem"),
    ).then((rows) =>
      rows.filter((row) => row.action === "field_evaluator_network")
    );
    await db.insert(roles).values({
      id: "domain-network-author",
      name: "网络授权出题人",
      description: "测试显式网络能力",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    await db.insert(rolePermissions).values({
      role_id: "domain-network-author",
      permission_id: permission.id,
    });
    await db.insert(userRoles).values({
      user_id: actor.sub,
      role_id: "domain-network-author",
    });
    const created = await jsonRequest(app, prefix, {
      token,
      method: "POST",
      body: input,
    });
    assertEquals(created.status, 201, await created.clone().text());
    const identity = await created.json();
    const draft =
      await (await jsonRequest(app, `${prefix}/${identity.number}/draft`, {
        token,
      })).json();
    assertEquals(draft.content.llm_config, { max_calls: 1 });
  },
});
