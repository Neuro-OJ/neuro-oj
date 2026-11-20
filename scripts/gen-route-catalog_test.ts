/**
 * 路由目录生成器测试（2026-09-12 架构评审 §3.4）。
 *
 * 核心回归点：原正则未锚定接收者 + 不校验路径形状，把 `c.get("userId")` 之类的
 * 上下文读取当成路由，365 行目录里 112 行是伪造条目，而 `--check` 只比对
 * "文件与生成结果一致"，从不校验生成结果是否正确。
 */
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@^1";
import {
  collectRouteFiles,
  extractRoutes,
  generate,
} from "./gen-route-catalog.ts";

function withTempFile(content: string, fn: (path: string) => void): void {
  const dir = Deno.makeTempDirSync({ prefix: "route-catalog-test-" });
  const path = `${dir}/fixture.ts`;
  try {
    Deno.writeTextFileSync(path, content);
    fn(path);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
}

Deno.test("gen-route-catalog: 只提取真实路由，忽略上下文读取与环境变量", () => {
  withTempFile(
    [
      `const userId = c.get("userId");`,
      `const env = Deno.env.get("NOJ_ENV");`,
      `const jti = payload.get("jti");`,
      `const role = c.get("userRole");`,
      `router.get("/api/v1/problems", listProblems);`,
      `app.post('/api/v1/submissions', createSubmission);`,
      `adminRouter.patch(\`/api/v1/admin/users/:id/role\`, changeRole);`,
    ].join("\n"),
    (path) => {
      const routes = extractRoutes(path);
      assertEquals(
        routes.map((r) => `${r.method} ${r.path}`),
        [
          "GET /api/v1/problems",
          "POST /api/v1/submissions",
          "PATCH /api/v1/admin/users/:id/role",
        ],
      );
    },
  );
});

Deno.test("gen-route-catalog: 路径必须以 / 开头（防御任何漏网误判）", () => {
  withTempFile(
    `foo.get("not-a-path");\nbar.delete("also-not");\nbaz.get("/real");\n`,
    (path) => {
      const routes = extractRoutes(path);
      assertEquals(routes.length, 1);
      assertEquals(routes[0].path, "/real");
    },
  );
});

Deno.test("gen-route-catalog: 生成结果按方法/路径/文件排序", () => {
  const content = generate([
    { method: "POST", path: "/b", file: "z.ts" },
    { method: "GET", path: "/c", file: "a.ts" },
    { method: "GET", path: "/a", file: "a.ts" },
  ]);
  const rows = content.split("\n").filter((l) =>
    l.startsWith("| GET") ||
    l.startsWith("| POST")
  );
  assertEquals(rows, [
    "| GET | `/a` | a.ts |",
    "| GET | `/c` | a.ts |",
    "| POST | `/b` | z.ts |",
  ]);
});

Deno.test("gen-route-catalog: 真实仓库目录中不存在伪造路径", () => {
  const content = generate(collectRouteFiles().flatMap(extractRoutes));
  const rows = content.split("\n").filter((l) =>
    /^\| (GET|POST|PUT|PATCH|DELETE) \|/.test(l)
  );
  assert(rows.length >= 200, `路由行数异常偏少：${rows.length}`);
  const fabricated = rows.filter((l) => !/^\| [A-Z]+ \| `\//.test(l));
  assertEquals(fabricated, [], "目录中出现不以 / 开头的伪造路径");
});

Deno.test("gen-route-catalog: 模块迁移后仍发现真实路由并排除测试和组合入口", () => {
  const root = Deno.makeTempDirSync({ prefix: "route-module-discovery-" });
  const base = `${root}/noj-core/src/modules/problems`;
  try {
    Deno.mkdirSync(`${base}/routes`, { recursive: true });
    Deno.mkdirSync(`${base}/tests/routes`, { recursive: true });
    Deno.writeTextFileSync(
      `${base}/routes/problems.ts`,
      'router.get("/problems", handler);',
    );
    Deno.writeTextFileSync(
      `${base}/routes/index.ts`,
      'router.get("/composition", handler);',
    );
    Deno.writeTextFileSync(
      `${base}/tests/routes/problems.test.ts`,
      'router.get("/fake", handler);',
    );
    assertEquals(collectRouteFiles(root), [`${base}/routes/problems.ts`]);
    assertEquals(
      collectRouteFiles(root).flatMap(extractRoutes).map((route) => route.path),
      ["/problems"],
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("gen-route-catalog: const 模板插值解析为真实路径", () => {
  withTempFile(
    [
      `const prefix = "/domains/:slug";`,
      "router.get(\`\${prefix}/copy-sources\`, handler);",
      "router.post(\`\${prefix}/problem-bindings\`, handler);",
    ].join("\n"),
    (path) => {
      assertEquals(
        extractRoutes(path).map((r) => `${r.method} ${r.path}`),
        [
          "GET /domains/:slug/copy-sources",
          "POST /domains/:slug/problem-bindings",
        ],
      );
    },
  );
});

Deno.test("gen-route-catalog: 不可解析的模板路由报错而不是静默丢弃", () => {
  withTempFile(
    "router.get(\`\${dynamicPrefix}/copy-sources\`, handler);",
    (path) => {
      assertThrows(() => extractRoutes(path), Error, "无法静态解析路由模板");
    },
  );
});

Deno.test("gen-route-catalog: 非路由模板调用被忽略", () => {
  withTempFile(
    ['const key = "user";', "cache.get(\`\${key}:profile\`);"].join("\n"),
    (path) => assertEquals(extractRoutes(path).length, 0),
  );
});

Deno.test("gen-route-catalog: 发现功能切片 routes.ts 并排除功能内测试", () => {
  const root = Deno.makeTempDirSync({ prefix: "route-feature-discovery-" });
  const base = `${root}/noj-core/src/features/demo`;
  try {
    Deno.mkdirSync(base, { recursive: true });
    const route = 'r.get("/demo/ping", (c) => c.text("ok"));\n';
    Deno.writeTextFileSync(`${base}/routes.ts`, route);
    Deno.writeTextFileSync(`${base}/routes.test.ts`, route);
    Deno.writeTextFileSync(`${base}/service.ts`, "export const x = 1;\n");
    const files = collectRouteFiles(root).map((f) => f.slice(root.length + 1));
    assertEquals(files, ["noj-core/src/features/demo/routes.ts"]);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});
