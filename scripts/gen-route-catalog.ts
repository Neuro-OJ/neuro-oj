// 生成 API 路由目录（docs/engineering/route-catalog.md）。
// 从 noj-core/src/routes/*.ts 提取 Hono 路由定义。
// 用法：deno run -A scripts/gen-route-catalog.ts [--check]
import { relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname ?? ".", "..");
const ROUTES_DIR = resolve(ROOT, "noj-core/src/routes");
const OUTPUT_PATH = resolve(ROOT, "docs/engineering/route-catalog.md");

interface RouteEntry {
  method: string;
  path: string;
  file: string;
}

function collectRouteFiles(): string[] {
  const files: string[] = [];
  for (const entry of Deno.readDirSync(ROUTES_DIR)) {
    if (entry.isFile && entry.name.endsWith(".ts")) {
      files.push(`${ROUTES_DIR}/${entry.name}`);
    }
  }
  return files;
}

function extractRoutes(file: string): RouteEntry[] {
  const text = Deno.readTextFileSync(file);
  const entries: RouteEntry[] = [];
  const re = /\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g;
  for (const m of text.matchAll(re)) {
    entries.push({
      method: m[1].toUpperCase(),
      path: m[2],
      file: relative(ROOT, file),
    });
  }
  return entries;
}

function generate(entries: RouteEntry[]): string {
  const lines = [
    "# NOJ API 路由目录",
    "",
    "> 由 `scripts/gen-route-catalog.ts` 生成，请勿手改。",
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
  const entries = collectRouteFiles().flatMap(extractRoutes);
  const content = generate(entries);
  if (check) {
    const existing = Deno.readTextFileSync(OUTPUT_PATH);
    if (existing !== content) {
      console.error(
        "路由目录已过期，请运行 deno run -A scripts/gen-route-catalog.ts",
      );
      Deno.exit(1);
    }
    console.log("路由目录最新");
  } else {
    Deno.writeTextFileSync(OUTPUT_PATH, content);
    console.log(`已生成 ${OUTPUT_PATH}`);
  }
}
