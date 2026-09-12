// 生成 API 路由目录（dev-docs/engineering/route-catalog.md）。
// 从 noj-core/src/routes/*.ts 提取 Hono 路由定义。
// 用法：deno run -A scripts/gen-route-catalog.ts [--check]
import { relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname ?? ".", "..");
const ROUTES_DIR = resolve(ROOT, "noj-core/src/routes");
const OUTPUT_PATH = resolve(ROOT, "dev-docs/engineering/route-catalog.md");

interface RouteEntry {
  method: string;
  path: string;
  file: string;
}

/** 目录不存在时返回 false（statSync 对缺失路径会抛错，不能直接读 isDirectory）。 */
function isDirectory(path: string): boolean {
  try {
    return Deno.statSync(path).isDirectory;
  } catch {
    return false;
  }
}

function collectRouteFiles(): string[] {
  const files: string[] = [];
  const roots = [ROUTES_DIR, resolve(ROOT, "noj-core/src/domains")];
  for (const root of roots) {
    if (!isDirectory(root)) continue;
    const queue = [root];
    while (queue.length > 0) {
      const dir = queue.shift()!;
      for (const entry of Deno.readDirSync(dir)) {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory) {
          queue.push(full);
        } else if (
          entry.isFile && entry.name.endsWith(".ts") &&
          full.includes("/routes/") && !full.includes("/tests/") &&
          !full.endsWith("/index.ts")
        ) {
          files.push(full);
        }
      }
    }
  }
  return files;
}

/**
 * 路由定义正则。
 *
 * 修复记录（2026-09-12 架构评审 §3.4）：原正则
 * `/\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g` **未锚定接收者**，
 * 于是 `c.get("userId")`、`Deno.env.get("NOJ_ENV")`、`c.get("jti")` 都被当成路由，
 * 365 行目录里 112 行（31%）是伪造条目；而 `--check` 只比对"文件与生成结果一致"，
 * 不校验生成结果是否正确，因此长期放行。
 *
 * 现在要求：
 *   1. 调用必须挂在某个标识符接收者上（`router.get(...)` / `app.post(...)`）；
 *   2. 路径必须以 `/` 开头（Hono 路由路径的硬约束）。
 * 仅满足第 2 条即可排除 `c.get("userId")` 这类上下文读取，两条叠加进一步降低误判。
 */
const ROUTE_RE =
  /\b([A-Za-z_$][\w$]*)\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g;

/**
 * 真实路由条数下限（防止解析规则与写法脱节后"生成空目录仍判最新"）。
 * 随路由增删同步上调；下调必须是有意为之并说明原因。
 */
const MIN_ROUTE_COUNT = 200;

export function extractRoutes(file: string): RouteEntry[] {
  const text = Deno.readTextFileSync(file);
  const entries: RouteEntry[] = [];
  for (const m of text.matchAll(ROUTE_RE)) {
    const path = m[3];
    // 路径必须以 / 开头——非路径的第二参数（如 c.get("userId")）在此被排除
    if (!path.startsWith("/")) continue;
    entries.push({
      method: m[2].toUpperCase(),
      path,
      file: relative(ROOT, file),
    });
  }
  return entries;
}

export function generate(entries: RouteEntry[]): string {
  const lines = [
    "# NOJ API 路由目录",
    "",
    "> 由 `scripts/gen-route-catalog.ts` 生成，请勿手改。",
    "> 扫描范围：`src/routes/*.ts` 与 `src/domains/*/routes/*.ts`（不含 `routes/index.ts` 组合文件）。",
    "",
    "| 方法 | 路径 | 文件 |",
    "| --- | --- | --- |",
  ];
  for (
    const entry of entries.sort((a, b) =>
      a.method.localeCompare(b.method) ||
      a.path.localeCompare(b.path) ||
      a.file.localeCompare(b.file)
    )
  ) {
    lines.push(`| ${entry.method} | \`${entry.path}\` | ${entry.file} |`);
  }
  return lines.join("\n") + "\n";
}

if (import.meta.main) {
  const check = Deno.args.includes("--check");
  const routeFiles = collectRouteFiles();
  const entries = routeFiles.flatMap(extractRoutes);

  // ── 门禁自检（2026-09-12 评审 §3.4）──
  // 没有自检时，解析规则失效只会"生成一份错误的目录并与自身比对通过"。
  const errors: string[] = [];
  if (routeFiles.length === 0) {
    errors.push("未扫描到任何路由文件（扫描根目录或过滤规则已失效）");
  }
  if (entries.length < MIN_ROUTE_COUNT) {
    errors.push(
      `解析到的路由数 ${entries.length} 低于下限 ${MIN_ROUTE_COUNT}（解析规则可能已与代码写法脱节）`,
    );
  }
  const nonAbsolute = entries.filter((e) => !e.path.startsWith("/"));
  if (nonAbsolute.length > 0) {
    errors.push(
      `存在不以 / 开头的"路径"（误判）：${
        nonAbsolute.slice(0, 5).map((e) => e.path).join(", ")
      }`,
    );
  }
  if (errors.length > 0) {
    console.error("路由目录生成失败（自检未通过）：");
    for (const e of errors) console.error(`- ${e}`);
    Deno.exit(1);
  }

  const content = generate(entries);
  if (check) {
    let existing = "";
    try {
      existing = Deno.readTextFileSync(OUTPUT_PATH);
    } catch {
      console.error(`路由目录不存在：${OUTPUT_PATH}，请运行生成脚本`);
      Deno.exit(1);
    }
    if (existing !== content) {
      console.error(
        "路由目录已过期，请运行 deno run -A scripts/gen-route-catalog.ts",
      );
      Deno.exit(1);
    }
    console.log(
      `路由目录最新（${routeFiles.length} 个路由文件 / ${entries.length} 条路由）`,
    );
  } else {
    Deno.writeTextFileSync(OUTPUT_PATH, content);
    console.log(
      `已生成 ${OUTPUT_PATH}（${routeFiles.length} 个路由文件 / ${entries.length} 条路由）`,
    );
  }
}
