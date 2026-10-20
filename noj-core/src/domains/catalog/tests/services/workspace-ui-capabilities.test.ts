import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import { zipSync } from "fflate";
import { eq } from "drizzle-orm";
import { createApp } from "../../../../app.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import { resetDbForTest } from "../../../../../tests/helpers/db.ts";
import {
  domainProblemBindings,
  llmModelAliases,
  problems,
  problemVersionObjects,
  problemVersions,
} from "../../../../shared/db/schema.ts";
import { createUserToken, jsonRequest } from "../../../../../tests/helper.ts";
import { verifyToken } from "../../../identity/index.ts";
import {
  consumeDomainInvitation,
  createDomain,
  createDomainInvitation,
} from "../../../workspace/index.ts";
import {
  getStorageProvider,
  uploadStorageObjectWithReservation,
} from "../../../system/index.ts";
import { parseDomainDraftBundle } from "../../services/workspace/problem-bundle-edit.ts";
import {
  importDomainProblem,
  setDomainProblemBindingPolicy,
} from "../../services/workspace/problem-bindings.ts";
import { setDomainProblemSharing } from "../../services/workspace/problem-sharing.ts";
import { BadRequestError } from "../../../../shared/base/errors.ts";

const encode = (value: string) => new TextEncoder().encode(value);
const runtime = {
  evaluator: {
    image: "noj-evaluator-python",
    command: "python3 /workspace/evaluate.py",
    time_limit_ms: 5000,
    memory_limit_mb: 512,
  },
  solution: {
    image: "noj-solution-python",
    call_timeout_ms: 1000,
    memory_limit_mb: 256,
  },
};
Deno.test("域集成能力：界面题包须有ui.html，v2保留模型能力和预测单容器", () => {
  const manifest = {
    format_version: 2,
    title: "界面题",
    description: "题面",
    submission_mode: "ui",
    runtime_config: runtime,
  };
  const bundle = (extra: Record<string, Uint8Array> = {}) =>
    zipSync({
      "problem.json": encode(JSON.stringify(manifest)),
      "evaluate.py": encode("print(1)"),
      ...extra,
    });
  assertThrows(
    () => parseDomainDraftBundle(bundle()),
    BadRequestError,
    "ui.html",
  );
  assertEquals(
    parseDomainDraftBundle(bundle({ "ui.html": encode("<p>界面</p>") })).content
      .submission_mode,
    "ui",
  );
  const prediction = parseDomainDraftBundle(zipSync({
    "problem.json": encode(
      JSON.stringify({
        ...manifest,
        submission_mode: "prediction",
        runtime_config: {
          evaluator: { ...runtime.evaluator, workspace_size_mb: 2048 },
        },
      }),
    ),
    "evaluate.py": encode("print(1)"),
  }));
  assertEquals("solution" in prediction.manifest.runtime_config!, false);
});

Deno.test({
  name: "域集成能力：HTTP共享界面取目标版本，模板不公开且撤销即时拒绝",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await resetDbForTest();
    const adminToken = await createUserToken("admin"),
      actor = (await verifyToken(adminToken))!.sub;
    const studentToken = await createUserToken("user");
    const source = await createDomain({
      slug: "ui-source",
      name: "界面来源",
      preset: "community",
    }, actor);
    const school = await createDomain({
      slug: "ui-school",
      name: "使用域",
      preset: "community",
    }, actor);
    const studentId = (await verifyToken(studentToken))!.sub;
    const invitation = await createDomainInvitation(
      school.slug,
      actor,
      `${studentId}@test.local`,
    );
    await consumeDomainInvitation(invitation.token, studentId);
    const other = await createDomain({
      slug: "ui-other",
      name: "无绑定域",
      preset: "community",
    }, actor);
    const id = crypto.randomUUID(),
      now = new Date().toISOString(),
      versions = [crypto.randomUUID(), crypto.randomUUID()];
    await getDb().insert(llmModelAliases).values([
      {
        domain_id: source.id,
        alias: "fast",
        provider_id: crypto.randomUUID(),
        model: "source-model",
        description: "来源域能力",
        updated_at: now,
      },
      {
        domain_id: school.id,
        alias: "fast",
        provider_id: crypto.randomUUID(),
        model: "school-model",
        description: "学校域能力",
        updated_at: now,
      },
    ]);
    await getDb().insert(problems).values({
      id,
      domain_id: source.id,
      number: 1001,
      title: "界面源题",
      description: "题面",
      owner_id: actor,
      submission_mode: "ui",
      visibility: "public",
      created_at: now,
      updated_at: now,
    });
    const storage = await getStorageProvider(), urls: string[] = [];
    try {
      for (const [index, versionId] of versions.entries()) {
        await getDb().insert(problemVersions).values({
          id: versionId,
          problem_id: id,
          version: index + 1,
          content: {
            kind: "ai",
            title: "界面题",
            description: "题面",
            samples: [],
            submission_mode: "ui",
            runtime_config: runtime,
            template_content: "可信脚本",
            artifact_max_size_mb: null,
            llm_config: null,
          },
          published_at: now,
        });
        const url = (await uploadStorageObjectWithReservation({
          key: `test-domain-ui/${versionId}.zip`,
          bytes: zipSync({
            "ui.html": encode(`<h1>V${index + 1}</h1>`),
            "evaluate.py": encode("print(1)"),
          }),
          contentType: "application/zip",
          domainId: source.id,
        })).storageUrl;
        urls.push(url);
        await getDb().insert(problemVersionObjects).values({
          version_id: versionId,
          role: "support_package",
          path: "package.zip",
          storage_url: url,
        });
      }
      await getDb().update(problems).set({ latest_version_id: versions[1] })
        .where(eq(problems.id, id));
      await getDb().insert(domainProblemBindings).values({
        id: crypto.randomUUID(),
        domain_id: source.id,
        problem_id: id,
        kind: "owned",
        visibility: "public",
        created_by: actor,
        created_at: now,
        updated_at: now,
      });
      await setDomainProblemSharing(source.slug, "1001", actor, {
        expectedRevision: 0,
        enabled: true,
        scope: "all",
        targetDomainIds: [],
      });
      await importDomainProblem(school.slug, "ui-source:1001", actor);
      const app = createApp(),
        path = `/api/v1/domains/${school.slug}/problems/ui-source:1001`;
      const capabilities = await jsonRequest(
        app,
        `/api/v1/domains/${school.slug}/problems/llm-model-aliases`,
        { token: adminToken },
      );
      assertEquals(capabilities.status, 200);
      const capabilityRows = (await capabilities.json()).data;
      assertEquals(capabilityRows, [{
        alias: "default",
        description: "使用当前工作空间默认模型",
      }, { alias: "fast", description: "学校域能力" }]);
      assertEquals(
        (await jsonRequest(
          app,
          `/api/v1/domains/${school.slug}/problems/llm-model-aliases`,
          { token: studentToken },
        )).status,
        403,
      );
      let response = await jsonRequest(
        app,
        `${path}/ui?version_id=${versions[1]}`,
        { token: studentToken },
      );
      assertEquals(response.status, 200);
      assertEquals((await response.json()).data.html, "<h1>V2</h1>");
      assertEquals(
        (await jsonRequest(app, `${path}/template`, { token: studentToken }))
          .status,
        404,
      );
      await setDomainProblemBindingPolicy(
        school.slug,
        "ui-source:1001",
        actor,
        0,
        { mode: "exact", version_id: versions[0] },
        "固定界面V1",
      );
      response = await jsonRequest(app, `${path}/ui`, { token: studentToken });
      assertEquals((await response.json()).data.html, "<h1>V1</h1>");
      assertEquals(
        (await jsonRequest(app, `${path}/ui?version_id=${versions[1]}`, {
          token: studentToken,
        })).status,
        409,
      );
      assertEquals(
        (await jsonRequest(
          app,
          `/api/v1/domains/${other.slug}/problems/ui-source:1001/ui`,
          { token: studentToken },
        )).status,
        404,
      );
      await setDomainProblemSharing(source.slug, "1001", actor, {
        expectedRevision: 1,
        enabled: false,
        scope: "all",
        targetDomainIds: [],
      });
      assertEquals(
        (await jsonRequest(app, `${path}/ui`, { token: studentToken })).status,
        404,
      );
    } finally {
      await Promise.all(urls.map((url) => storage.delete(url)));
    }
  },
});
