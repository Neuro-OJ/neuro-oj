/**
 * OI 独立编辑路径的路由测试（Handbook §6.3、批次 2c）。
 *
 * 验证「内容写草稿、管理信息写题目行」的分离：
 * - `POST /problems/oi-author/new/save` 创建身份 + 草稿（配置与逐文件引用同批切换），
 *   题目保持**未发布**；
 * - metadata-only 保存复用草稿文件引用，不访问对象存储；
 * - 缺少 `draft_revision` 返回 428，过时返回 409；
 * - 显式发布后才改变投影与版本文件引用。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { createApp } from "../../../../app.ts";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import {
  problemDraftObjects,
  problems,
  problemVersionObjects,
} from "../../../../shared/db/schema.ts";
import {
  createUserToken,
  initRedisForTest,
} from "../../../../../tests/helper.ts";
import {
  resetStorageProvider,
  setStorageProviderForTest,
  type StorageProvider,
} from "../../../system/index.ts";
import { LocalStorageProvider } from "../../../system/services/storage/local.ts";
import type { OiRuntimeConfig } from "../../types/runtime-config.ts";

const hasEnv = !!Deno.env.get("JWT_SECRET");
const skip = !hasEnv;

const tempStorageDir = Deno.makeTempDirSync({ prefix: "noj-oi-author-" });

await resetDbForTest();
await initRedisForTest();

function oiConfig(): OiRuntimeConfig {
  return {
    backend: "wasm",
    languages: ["cc"],
    time_limit_ms: 1000,
    memory_limit_mb: 256,
    checker: { type: "default" },
    subtasks: [{
      id: "s1",
      score: 100,
      cases: [{ input: "testdata/1.in", output: "testdata/1.out" }],
    }],
  };
}

function saveForm(
  metadata: Record<string, unknown>,
  files: { path: string; body: Uint8Array }[] = [],
): FormData {
  const form = new FormData();
  form.append("metadata", JSON.stringify(metadata));
  for (const item of files) {
    form.append(
      "data_files",
      new File([item.body as BlobPart], item.path.split("/").at(-1)!),
      item.path,
    );
  }
  return form;
}

async function save(
  app: ReturnType<typeof createApp>,
  token: string,
  reference: string,
  form: FormData,
): Promise<Response> {
  return await app.request(
    `/api/v1/problems/oi-author/${reference}/save`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    },
  );
}

Deno.test({
  name:
    "oi author route: 新建 OI 题写草稿（配置 + 逐文件引用），题目保持未发布",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await createUserToken("admin");
    setStorageProviderForTest(new LocalStorageProvider(tempStorageDir));
    try {
      const metadata = {
        problem: {
          title: `OI 新建 ${Date.now()}`,
          description: "题面",
          type: "P",
          difficulty: "easy",
          runtime_config: oiConfig(),
        },
        upload_paths: ["testdata/1.in", "testdata/1.out"],
      };
      const response = await save(
        app,
        token,
        "new",
        saveForm(metadata, [
          { path: "testdata/1.in", body: new TextEncoder().encode("1\n") },
          { path: "testdata/1.out", body: new TextEncoder().encode("1\n") },
        ]),
      );
      assertEquals(response.status, 200);
      const body = (await response.json()).data;
      assertEquals(body.files_changed, true);
      assertEquals(body.draft_revision >= 2, true);

      const [row] = await getDb().select().from(problems).where(
        eq(problems.id, body.id as string),
      );
      // 未发布：投影里的 latest_version_id 仍为空
      assertEquals(row.latest_version_id, null);
      assertEquals(row.runtime_config, oiConfig() as never);

      const refs = await getDb().select().from(problemDraftObjects).where(
        eq(problemDraftObjects.problem_id, body.id as string),
      );
      assertEquals(refs.filter((ref) => ref.role === "oi_file").length, 2);
      assertEquals(
        refs.some((ref) =>
          ref.role === "support_package" &&
          ref.path === "package.zip"
        ),
        true,
      );

      // 文件列表从草稿作用域读取，并回传乐观锁 revision
      const listing = await app.request(
        `/api/v1/problems/oi-author/${body.id}/files`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      assertEquals(listing.status, 200);
      const listed = (await listing.json()).data;
      assertEquals(listed.draft_revision, body.draft_revision);
      assertEquals(
        listed.files.map((item: { path: string }) => item.path).sort(),
        ["testdata/1.in", "testdata/1.out"],
      );

      // 显式发布：投影与版本文件引用此时才固定
      const published = await app.request(
        `/api/v1/problems/${body.id}/versions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "If-Match": String(body.draft_revision),
          },
          body: JSON.stringify({ change_note: "V1" }),
        },
      );
      assertEquals(published.status, 201);
      const versionId = (await published.json()).data.version_id as string;
      const [afterPublish] = await getDb().select().from(problems).where(
        eq(problems.id, body.id as string),
      );
      assertEquals(afterPublish.latest_version_id, versionId);
      const versionRefs = await getDb().select().from(problemVersionObjects)
        .where(eq(problemVersionObjects.version_id, versionId));
      assertEquals(
        versionRefs.filter((ref) => ref.role === "oi_file").length,
        2,
      );
    } finally {
      resetStorageProvider();
    }
  },
});

Deno.test({
  name:
    "oi author route: metadata-only 保存复用草稿引用、不访问对象存储，缺 revision 428",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await createUserToken("admin");
    setStorageProviderForTest(new LocalStorageProvider(tempStorageDir));
    let problemId = "";
    try {
      const created = await save(
        app,
        token,
        "new",
        saveForm({
          problem: {
            title: `OI 配置 ${Date.now()}`,
            description: "题面",
            type: "P",
            difficulty: "easy",
            runtime_config: oiConfig(),
          },
          upload_paths: ["testdata/1.in", "testdata/1.out"],
        }, [
          { path: "testdata/1.in", body: new TextEncoder().encode("1\n") },
          { path: "testdata/1.out", body: new TextEncoder().encode("1\n") },
        ]),
      );
      assertEquals(created.status, 200);
      const createdBody = (await created.json()).data;
      const draftRevision = createdBody.draft_revision as number;
      problemId = createdBody.id as string;
      assertEquals(typeof problemId, "string");
      assertEquals(typeof draftRevision, "number");

      // 不再访问对象存储：任何 put/get/delete 都会抛错
      const calls: string[] = [];
      setStorageProviderForTest(
        new Proxy({} as StorageProvider, {
          get(_target, operation) {
            return () => {
              calls.push(String(operation));
              throw new Error("metadata-only 保存不应访问对象存储");
            };
          },
        }),
      );

      const revised = oiConfig();
      revised.subtasks[0].scoring = "max";
      const saved = await save(
        app,
        token,
        problemId,
        saveForm({
          problem: {
            title: "新标题",
            description: "题面",
            type: "P",
            runtime_config: revised,
          },
          draft_revision: draftRevision,
        }),
      );
      assertEquals(saved.status, 200);
      const savedBody = (await saved.json()).data;
      assertEquals(savedBody.draft_revision, draftRevision + 1);
      assertEquals(savedBody.files_changed, false);
      assertEquals(calls, []);

      // 引用缺失文件 → 400，且不递增 revision
      const invalid = oiConfig();
      invalid.subtasks[0].cases = [{
        input: "testdata/missing.in",
        output: "testdata/1.out",
      }];
      const rejected = await save(
        app,
        token,
        problemId,
        saveForm({
          problem: {
            title: "不应保存",
            description: "题面",
            type: "P",
            runtime_config: invalid,
          },
          draft_revision: savedBody.draft_revision,
        }),
      );
      assertEquals(rejected.status, 400);
      assertEquals(calls, []);

      // 缺少 draft_revision → 428（不静默绑定新版草稿）
      const missing = await save(
        app,
        token,
        problemId,
        saveForm({
          problem: {
            title: "不应保存",
            description: "题面",
            type: "P",
            runtime_config: oiConfig(),
          },
        }),
      );
      assertEquals(missing.status, 428);

      // 过时 revision → 409
      const stale = await save(
        app,
        token,
        problemId,
        saveForm({
          problem: {
            title: "不应保存",
            description: "题面",
            type: "P",
            runtime_config: oiConfig(),
          },
          draft_revision: draftRevision,
        }),
      );
      assertEquals(stale.status, 409);
    } finally {
      resetStorageProvider();
    }
  },
});
