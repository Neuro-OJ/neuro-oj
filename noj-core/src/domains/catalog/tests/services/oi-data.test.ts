import { assertEquals } from "jsr:@std/assert@^1";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { problems } from "../../../../shared/db/schema.ts";
import { initRedisForTest } from "../../../../../tests/helper.ts";
import { saveOiMetadata } from "../../services/oi-data.ts";
import {
  resetStorageProvider,
  setStorageProviderForTest,
  type StorageProvider,
} from "../../../system/index.ts";
import type { OiRuntimeConfig } from "../../types/runtime-config.ts";

await resetDbForTest();
await initRedisForTest();

Deno.test({
  name: "OI 仅配置保存复用大数据对象，不读取或上传数据，并校验新增文件引用",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const config: OiRuntimeConfig = {
      backend: "wasm",
      languages: ["cc"],
      time_limit_ms: 1000,
      memory_limit_mb: 256,
      checker: { type: "default" },
      subtasks: [{
        id: "all",
        score: 100,
        scoring: "sum",
        cases: [{ input: "1.in", output: "1.out" }],
      }],
    };
    const index = {
      "1.in": {
        storage_url: "noj-storage://s3/input",
        size: 64 * 1024 * 1024,
        hash: "a",
      },
      "1.out": { storage_url: "noj-storage://s3/output", size: 1, hash: "b" },
    };
    await getDb().insert(problems).values({
      id,
      title: "保存回归",
      description: "描述",
      type: "P",
      number: 998877,
      owner_id: "0",
      difficulty: "easy",
      judge_type: "oi",
      runtime_config: config,
      oi_data_files: index,
      support_package_storage_url: "noj-storage://s3/old-runtime.zip",
      created_at: now,
      updated_at: now,
    });
    const storageCalls: string[] = [];
    setStorageProviderForTest(
      new Proxy({} as StorageProvider, {
        get(_target, operation) {
          return () => {
            storageCalls.push(String(operation));
            throw new Error("配置保存不应访问数据对象");
          };
        },
      }),
    );
    const app = new Hono<
      {
        Variables: { userId: string; userRole: string; userPerms: Set<string> };
      }
    >();
    app.post("/save", async (c) => {
      c.set("userId", "0");
      c.set("userRole", "admin");
      c.set("userPerms", new Set(["admin:full_access"]));
      const body = await c.req.json();
      return c.json(await saveOiMetadata(c, id, body.input, body.updated_at));
    });
    try {
      const revised = {
        ...config,
        subtasks: [{ ...config.subtasks[0], scoring: "max" }],
      };
      const response = await app.request("/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          input: { title: "新标题", runtime_config: revised },
          updated_at: now,
        }),
      });
      assertEquals(response.status, 200);
      const [row] = await getDb().select().from(problems).where(
        eq(problems.id, id),
      );
      assertEquals(row.title, "新标题");
      assertEquals(row.oi_data_files, index);
      assertEquals(
        row.support_package_storage_url,
        "noj-storage://s3/old-runtime.zip",
      );
      assertEquals(storageCalls, []);
      const invalid = {
        ...config,
        subtasks: [{
          ...config.subtasks[0],
          cases: [{ input: "missing.in", output: "1.out" }],
        }],
      };
      app.onError((error, c) => c.json({ error: error.message }, 400));
      const rejected = await app.request("/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          input: { title: "不应保存", runtime_config: invalid },
          updated_at: row.updated_at,
        }),
      });
      assertEquals(rejected.status, 400);
      assertEquals(
        (await rejected.json()).error,
        "配置引用缺失文件：missing.in",
      );
      assertEquals(storageCalls, []);
    } finally {
      resetStorageProvider();
      await getDb().delete(problems).where(eq(problems.id, id));
    }
  },
});
