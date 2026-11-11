// 生成 API 路由目录（dev-docs/engineering/route-catalog.md）。
// 从遗留路由及工程元数据登记的模块路由提取 Hono 路由定义。
// 用法：deno run -A scripts/gen-route-catalog.ts [--check]
import { relative, resolve } from "node:path";
import { MODULE_TEST_METADATA } from "./module-test-metadata.ts";

const ROOT = resolve(import.meta.dirname ?? ".", "..");
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

/** 通过统一模块元数据发现迁移前后的路由，目录迁移不得静默减少扫描范围。 */
export function collectRouteFiles(repositoryRoot = ROOT): string[] {
  const files = new Set<string>();
  const roots = [
    resolve(repositoryRoot, "noj-core/src/routes"),
    resolve(repositoryRoot, "noj-core/src/domains"),
    // 功能切片：`src/features/<name>/routes.ts` 或 `routes/` 目录（core 重构阶段 3）。
    resolve(repositoryRoot, "noj-core/src/features"),
    ...MODULE_TEST_METADATA.targetModules.map((module) =>
      resolve(repositoryRoot, module.root)
    ),
  ];
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
          (full.includes("/routes/") ||
            (full.includes("/src/features/") && entry.name === "routes.ts")) &&
          !full.includes("/tests/") && !full.endsWith("/index.ts") &&
          !entry.name.endsWith(".test.ts") && !entry.name.endsWith("_test.ts")
        ) {
          files.add(full);
        }
      }
    }
  }
  return [...files].sort();
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
  /\b([A-Za-z_$][\w$]*)\.(get|post|put|patch|delete)\(\s*["']([^"']+)["']/g;

/**
 * 模板字面量路由（反引号路径）。
 *
 * 2026-11-04 评审补漏：旧正则把反引号也当路径引号，但路径以插值开头，被
 * "路径必须以 / 开头"的过滤静默丢弃——四条域资源路由因此从未进入目录，
 * --check 也一直判最新。这里单独解析插值，解析不了就报错，不再静默跳过。
 * 插值来源支持三类：同文件 const 字符串（含引用其他 const 的模板）、
 * for (const x of [字面量...]) 与 for (const [a, b] of [[字面量...]]) 循环变量。
 */
const TEMPLATE_ROUTE_RE =
  /\b([A-Za-z_$][\w$]*)\.(get|post|put|patch|delete)\(\s*\x60([^\x60]*)\x60/g;

/** 同文件 const 字符串或模板字面量声明，用于解析插值。 */
const CONST_VALUE_RE =
  /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|\x60([^\x60]*)\x60)/g;

/** 字面量枚举循环：for (const x of [...]) 与 for (const [a, b] of [[...]])。 */
const LITERAL_LOOP_RE =
  /for\s*\(\s*const\s+(\[[^\]]*\]|[A-Za-z_$][\w$]*)\s+of\s+(\[[\s\S]*?\])\s*(?:as\s+const\s*)?\)/g;

/** 取出字面量数组里的字符串（忽略数字、注释与嵌套括号）。 */
function literalStrings(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]);
}

/** 解析字面量数组为一组元组：一维数组是单个元组，二维数组每个内层一项。 */
function parseLiteralTuples(text: string): string[][] {
  if (text.trimStart().startsWith("[[")) {
    return [...text.matchAll(/\[([^\[\]]*)\]/g)].map((m) =>
      literalStrings(m[1])
    );
  }
  return [literalStrings(text)];
}

/** 同一标识符的多处绑定合并；路由目录取并集即可。 */
function addBindings(
  target: Map<string, string[]>,
  name: string,
  values: string[],
): void {
  const existing = target.get(name) ?? [];
  for (const value of values) {
    if (!existing.includes(value)) existing.push(value);
  }
  target.set(name, existing);
}

/** 收集可静态求值的 const 字符串，逐轮展开 const 之间的模板引用。 */
function collectConstants(text: string): Map<string, string> {
  const declared = new Map<string, string | undefined>();
  for (const m of text.matchAll(CONST_VALUE_RE)) {
    const name = m[1];
    const value = m[2] ?? m[3] ?? m[4] ?? "";
    if (declared.has(name) && declared.get(name) !== value) {
      declared.set(name, undefined);
    } else {
      declared.set(name, value);
    }
  }

  const resolved = new Map<string, string>();
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (const [name, value] of declared) {
      if (value === undefined) continue;
      const next = value.replace(
        /\$\{([A-Za-z_$][\w$]*)\}/g,
        (whole, dependency: string) => resolved.get(dependency) ?? whole,
      );
      if (next !== value) {
        declared.set(name, next);
        changed = true;
      }
      if (!next.includes(DOLLAR_BRACE)) resolved.set(name, next);
    }
    if (!changed) break;
  }
  return resolved;
}

/** 收集 for-of 字面量循环里的标识符取值。 */
function collectLoopBindings(text: string): Map<string, string[]> {
  const bindings = new Map<string, string[]>();
  for (const m of text.matchAll(LITERAL_LOOP_RE)) {
    const pattern = m[1];
    const tuples = parseLiteralTuples(m[2]);
    if (pattern.startsWith("[")) {
      const names = pattern
        .slice(1, -1)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      names.forEach((name, index) => {
        addBindings(
          bindings,
          name,
          tuples.map((tuple) => tuple[index]).filter((value) =>
            value !== undefined
          ),
        );
      });
    } else {
      addBindings(bindings, pattern, tuples.flat());
    }
  }
  return bindings;
}

/** 模板里的插值标记，避免在源码里写出插值定界符。 */
const DOLLAR_BRACE = "$" + "{";

interface TemplateExpansion {
  paths: string[];
  unresolved: string[];
}

/** 展开模板路由的全部取值；返回未解析的标识符而不是静默丢弃。 */
function expandTemplate(
  raw: string,
  constants: Map<string, string>,
  loops: Map<string, string[]>,
): TemplateExpansion {
  const names = [
    ...new Set(
      [...raw.matchAll(/\$\{([A-Za-z_$][\w$]*)\}/g)].map((m) => m[1]),
    ),
  ];
  const unresolved: string[] = [];
  let paths = [raw];
  for (const name of names) {
    const values = loops.get(name) ??
      (constants.has(name) ? [constants.get(name)!] : undefined);
    if (!values) {
      unresolved.push(name);
      continue;
    }
    const placeholder = DOLLAR_BRACE + name + "}";
    paths = paths.flatMap((path) =>
      values.map((value) => path.split(placeholder).join(value))
    );
    if (paths.length > 32) {
      throw new Error("路由模板枚举结果过多（上限 32）：" + raw);
    }
  }
  return { paths, unresolved };
}

/**
 * 真实路由条数下限（防止解析规则与写法脱节后"生成空目录仍判最新"）。
 * 随路由增删同步上调；下调必须是有意为之并说明原因。
 */
const MIN_ROUTE_COUNT = 200;

export function extractRoutes(file: string): RouteEntry[] {
  const text = Deno.readTextFileSync(file);
  const entries: RouteEntry[] = [];
  const push = (method: string, path: string) => {
    entries.push({
      method: method.toUpperCase(),
      path,
      file: relative(ROOT, file),
    });
  };

  for (const m of text.matchAll(ROUTE_RE)) {
    const path = m[3];
    // 路径必须以 / 开头——非路径的第二参数（如 c.get("userId")）在此被排除
    if (!path.startsWith("/")) continue;
    push(m[2], path);
  }

  const constants = collectConstants(text);
  const loops = collectLoopBindings(text);
  for (const m of text.matchAll(TEMPLATE_ROUTE_RE)) {
    const raw = m[3];
    // 只有看起来像路由的模板才值得报错；headers.get 之类的取键调用直接忽略。
    const looksLikeRoute = raw.startsWith("/") || raw.startsWith(DOLLAR_BRACE);
    const { paths, unresolved } = expandTemplate(raw, constants, loops);
    if (unresolved.length > 0) {
      if (looksLikeRoute) {
        throw new Error(
          "无法静态解析路由模板：" + raw + "（文件 " + relative(ROOT, file) +
            "），未解析插值：" + unresolved.join(", ") +
            "。请改用字面量路径，或把插值来源写成同文件的 const 字符串 / 字面量循环。",
        );
      }
      continue;
    }
    for (const path of paths) {
      if (path.includes(DOLLAR_BRACE)) {
        throw new Error(
          "路由模板含非标识符插值：" + raw + "（文件 " +
            relative(ROOT, file) + "），请改用字面量路径。",
        );
      }
      if (!path.startsWith("/")) continue;
      push(m[2], path);
    }
  }

  return entries;
}

export function generate(entries: RouteEntry[]): string {
  const lines = [
    "# NOJ API 路由目录",
    "",
    "> 由 `scripts/gen-route-catalog.ts` 生成，请勿手改。",
    "> 扫描范围：遗留 `src/routes`、`src/domains` 与工程元数据登记的 `src/modules` 路由（不含测试与 `routes/index.ts` 组合文件）。",
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
