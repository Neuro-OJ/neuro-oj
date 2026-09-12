/**
 * 路由目录生成器测试（2026-09-12 架构评审 §3.4）。
 *
 * 核心回归点：原正则未锚定接收者 + 不校验路径形状，把 `c.get("userId")` 之类的
 * 上下文读取当成路由，365 行目录里 112 行是伪造条目，而 `--check` 只比对
 * "文件与生成结果一致"，从不校验生成结果是否正确。
 */
import { assert, assertEquals } from "jsr:@std/assert@^1";
import { extractRoutes, generate } from "./gen-route-catalog.ts";

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

Deno.test("gen-route-catalog: 真实仓库目录中不存在伪造路径", async () => {
  const content = await Deno.readTextFile(
    new URL("../dev-docs/engineering/route-catalog.md", import.meta.url),
  );
  const rows = content.split("\n").filter((l) =>
    /^\| (GET|POST|PUT|PATCH|DELETE) \|/.test(l)
  );
  assert(rows.length >= 200, `路由行数异常偏少：${rows.length}`);
  const fabricated = rows.filter((l) => !/^\| [A-Z]+ \| `\//.test(l));
  assertEquals(fabricated, [], "目录中出现不以 / 开头的伪造路径");
});
