/**
 * 写端点限流覆盖门禁的自测（2026-09-12 架构评审 §4.6）。
 */
import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  checkWriteRateLimits,
  extractWriteRoutes,
  hasRateLimitEvidence,
} from "./check-write-rate-limits.ts";

Deno.test("write-rate-limit: 只提取写方法路由且路径须以 / 开头", () => {
  const text = [
    `router.get("/read-only");`,
    `router.post("/write-a", h);`,
    `app.patch('/write-b', h);`,
    `adminRouter.delete("/write-c", h);`,
    `const x = c.post("not-a-path");`,
    `const y = Deno.env.set("KEY");`,
  ].join("\n");
  assertEquals(extractWriteRoutes(text), [
    "POST /write-a",
    "PATCH /write-b",
    "DELETE /write-c",
  ]);
});

Deno.test("write-rate-limit: 限流证据识别", () => {
  assertEquals(
    hasRateLimitEvidence(`await enforceSubmissionRateLimit(c, userId);`),
    true,
  );
  assertEquals(
    hasRateLimitEvidence(`import { rateLimit } from "./x.ts";`),
    true,
  );
  assertEquals(hasRateLimitEvidence(`router.post("/x", h);`), false);
});

Deno.test("write-rate-limit: 新的无限流写路由文件必须失败", async () => {
  const root = await Deno.makeTempDir({ prefix: "write-rl-" });
  try {
    await Deno.mkdir(`${root}/noj-core/src/domains/demo/routes`, {
      recursive: true,
    });
    await Deno.writeTextFile(
      `${root}/noj-core/src/domains/demo/routes/v2.ts`,
      `router.post("/api/v2/demo", handler);\n`,
    );
    const { errors } = await checkWriteRateLimits(root);
    assert(
      errors.some((e) => e.includes("v2.ts")),
      `未限流写路由必须报错：${JSON.stringify(errors)}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("write-rate-limit: 已限流的文件不报错", async () => {
  const root = await Deno.makeTempDir({ prefix: "write-rl-" });
  try {
    await Deno.mkdir(`${root}/noj-core/src/domains/demo/routes`, {
      recursive: true,
    });
    await Deno.writeTextFile(
      `${root}/noj-core/src/domains/demo/routes/v2.ts`,
      `import { enforceReportRateLimit } from "../../system/index.ts";\n` +
        `router.post("/api/v2/demo", async (c) => { await enforceReportRateLimit(c, "u"); });\n`,
    );
    const { errors } = await checkWriteRateLimits(root);
    assertEquals(errors, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("write-rate-limit: 真实仓库通过且解析到足够多的写路由", async () => {
  const { errors, stats } = await checkWriteRateLimits(".");
  assertEquals(errors, []);
  assert(
    stats.write_routes >= 100,
    `写路由数量异常偏少（${stats.write_routes}），解析规则可能失效`,
  );
});
