import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { zipSync } from "fflate";
import { createApp } from "../../../../app.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import { resetDbForTest } from "../../../../../tests/helpers/db.ts";
import {
  problems,
  problemVersionObjects,
} from "../../../../shared/db/schema.ts";
import {
  createUserToken,
  deleteProblemFixtures,
  jsonRequest,
  publishBaselineVersionForTest,
} from "../../../../../tests/helper.ts";
import {
  getStorageProvider,
  uploadStorageObjectWithReservation,
} from "../../../platform/system/index.ts";
import { DEFAULT_DOMAIN_ID } from "../../../access/workspace/index.ts";

/**
 * 界面题 `GET /api/v1/problems/:id/ui` 与 `/template` 的路由测试。
 * 不依赖 Redis；支持包走测试环境的本地存储。
 */

const ts = Date.now();
const RUNTIME_CONFIG = {
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

await resetDbForTest();

async function insertProblem(
  mode: "code" | "ui",
  extra: Record<string, unknown> = {},
): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await getDb().insert(problems).values({
    id,
    title: `界面路由题 ${mode} ${ts}`,
    description: "测试",
    difficulty: "easy",
    domain_id: DEFAULT_DOMAIN_ID,
    number: 64000 + Math.floor(Math.random() * 900),
    owner_id: "0",
    submission_mode: mode,
    template_content: "def solve(x):\n    return 1\n",
    runtime_config: RUNTIME_CONFIG,
    created_at: now,
    updated_at: now,
    ...extra,
  });
  await publishBaselineVersionForTest(id);
  return id;
}

Deno.test({
  name: "problem-ui route: 无 token 返回 401",
  fn: async () => {
    const id = await insertProblem("ui");
    try {
      const res = await jsonRequest(
        createApp(),
        `/api/v1/problems/${id}/ui`,
        {},
      );
      assertEquals(res.status, 401);
    } finally {
      await deleteProblemFixtures(eq(problems.id, id));
    }
  },
});

Deno.test({
  name: "problem-ui route: 非界面题返回 404",
  fn: async () => {
    const id = await insertProblem("code");
    try {
      const token = await createUserToken("user");
      const res = await jsonRequest(createApp(), `/api/v1/problems/${id}/ui`, {
        token,
      });
      assertEquals(res.status, 404);
    } finally {
      await deleteProblemFixtures(eq(problems.id, id));
    }
  },
});

Deno.test({
  name:
    "problem-ui route: 界面题缺少 ui.html 返回 404；支持包含 ui.html 时返回内容",
  fn: async () => {
    const id = await insertProblem("ui");
    const storage = await getStorageProvider();
    const key = `test-ui/${id}.zip`;
    let packageUrl: string | undefined;
    try {
      const token = await createUserToken("user");
      const app = createApp();

      // 无支持包
      const none = await jsonRequest(app, `/api/v1/problems/${id}/ui`, {
        token,
      });
      assertEquals(none.status, 404);

      // 有支持包且含 ui.html
      const zip = zipSync({
        "evaluate.py": new TextEncoder().encode("print(1)"),
        "ui.html": new TextEncoder().encode("<h1>界面</h1>"),
      });
      packageUrl = (await uploadStorageObjectWithReservation({
        key,
        bytes: zip,
        contentType: "application/zip",
        domainId: DEFAULT_DOMAIN_ID,
      })).storageUrl;
      const versionId = await publishBaselineVersionForTest(id);
      await getDb().insert(problemVersionObjects).values({
        version_id: versionId,
        role: "support_package",
        path: "package.zip",
        storage_url: packageUrl,
      });
      const ok = await jsonRequest(app, `/api/v1/problems/${id}/ui`, {
        token,
      });
      assertEquals(ok.status, 200);
      assertEquals((await ok.json()).data.html, "<h1>界面</h1>");
    } finally {
      await deleteProblemFixtures(eq(problems.id, id));
      if (packageUrl) await storage.delete(packageUrl).catch(() => {});
    }
  },
});

Deno.test({
  name: "problem-ui route: 界面题的 /template 一律 404（不下发脚本模板）",
  fn: async () => {
    const uiId = await insertProblem("ui");
    const codeId = await insertProblem("code");
    try {
      const token = await createUserToken("user");
      const app = createApp();
      const ui = await jsonRequest(app, `/api/v1/problems/${uiId}/template`, {
        token,
      });
      assertEquals(ui.status, 404);
      const code = await jsonRequest(
        app,
        `/api/v1/problems/${codeId}/template`,
        { token },
      );
      assertEquals(code.status, 200);
    } finally {
      await deleteProblemFixtures(eq(problems.id, uiId));
      await deleteProblemFixtures(eq(problems.id, codeId));
    }
  },
});
