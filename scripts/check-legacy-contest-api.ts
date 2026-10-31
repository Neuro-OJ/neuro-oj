/**
 * 旧无域比赛 API 的下线门禁。
 *
 * 背景：0.11 起所有比赛按显式域路径（`/api/v1/domains/:slug/contests/...`）服务；
 * 无域 `/api/v1/contests/*` 只剩**只读兼容**，写方法已在生产返回 410。下线评估
 * 见 `.agents/notes/implemented/architecture/2026-10-31-legacy-contest-api-retirement-assessment.md`。
 *
 * 本门禁把"评估结论"变成可执行检查，只断言两条不会随实现漂移的事实：
 *
 * 1. **写方法必须已退役**：`contests.ts` 里仍声明的每个写方法（POST/PUT/PATCH/DELETE）
 *    都必须在 `retired-endpoints.json` 中登记，否则"退役"只是文档口头承诺。
 *    注意 `retiredEndpointMiddleware()` 只在生产启用，所以这条断言不能靠 HTTP 行为验证。
 * 2. **不允许新增第一方生产调用方**：除白名单登记的文件外，UI / CLI / IDE 插件的
 *    生产代码不得再引用 `/api/v1/contests`，否则 0.12 下线会掉功能。扫描前剥离注释，
 *    避免"文档里提到路径"被误判为调用方。
 *
 * 只做只读检查，不改任何业务数据。
 */
import { walk } from "jsr:@std/fs@^1";
import { relative, resolve } from "node:path";

/** 无域比赛前缀；只读兼容期间仍对外可达。 */
export const LEGACY_CONTEST_PREFIX = "/api/v1/contests";

/** `retired-endpoints.json` 中该前缀的完整路径形状。 */
export function normalizeLegacyPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed === "/") return LEGACY_CONTEST_PREFIX;
  // 已带前缀的完整路径（retired-endpoints.json 的写法）原样返回，不重复拼接。
  if (trimmed.startsWith(LEGACY_CONTEST_PREFIX)) return trimmed;
  return `${LEGACY_CONTEST_PREFIX}${
    trimmed.startsWith("/") ? trimmed : `/${trimmed}`
  }`;
}

export interface DeclaredRoute {
  method: string;
  path: string;
}

/** 从路由文件源码中提取本文件的 `contests.<method>(<path>, ...)` 声明。 */
export function extractDeclaredRoutes(source: string): DeclaredRoute[] {
  const routes: DeclaredRoute[] = [];
  const pattern = /\bcontests\.(get|post|patch|put|delete)\(\s*["'`]([^"'`]+)["'`]/g;
  for (const match of source.matchAll(pattern)) {
    routes.push({
      method: match[1]!.toUpperCase(),
      path: match[2]!,
    });
  }
  return routes;
}

/** 写方法：改造了状态，因此必须走显式域入口。 */
export function isWriteMethod(method: string): boolean {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase());
}

export interface RetiredEntry {
  method: string;
  path: string;
}

export interface RouteInventory {
  reads: DeclaredRoute[];
  writesRetired: DeclaredRoute[];
  writesNotRetired: DeclaredRoute[];
}

/** 按"写必须退役、读允许保留"给声明分类。 */
export function classifyRoutes(
  declared: DeclaredRoute[],
  retired: RetiredEntry[],
): RouteInventory {
  const retiredKeys = new Set(
    retired.map((entry) =>
      `${entry.method.toUpperCase()} ${normalizeLegacyPath(entry.path)}`
    ),
  );
  const inventory: RouteInventory = {
    reads: [],
    writesRetired: [],
    writesNotRetired: [],
  };
  for (const route of declared) {
    if (!isWriteMethod(route.method)) {
      inventory.reads.push(route);
      continue;
    }
    const key = `${route.method} ${normalizeLegacyPath(route.path)}`;
    if (retiredKeys.has(key)) inventory.writesRetired.push(route);
    else inventory.writesNotRetired.push(route);
  }
  return inventory;
}

/** 剥离 `//` 行注释与 `/* *\/` 块注释，保留行数（行号仍可对齐）。 */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/^\s*\/\/.*$/gm, (line) => " ".repeat(line.length));
}

export interface LegacyCaller {
  file: string;
  line: number;
  snippet: string;
}

/** 在给定文件内容中查找无域比赛前缀的引用（已剥离注释）。 */
export function findLegacyCallers(
  files: Array<{ file: string; text: string }>,
): LegacyCaller[] {
  const callers: LegacyCaller[] = [];
  for (const { file, text } of files) {
    const lines = stripComments(text).split("\n");
    lines.forEach((line, index) => {
      if (!line.includes(LEGACY_CONTEST_PREFIX)) return;
      callers.push({ file, line: index + 1, snippet: line.trim() });
    });
  }
  return callers;
}

/**
 * 生产代码白名单：这些文件仍引用无域前缀，且都是**不可达的过渡代码**。
 *
 * 每一条都必须写明"为什么现在可以留、什么时候必须消失"。登记后本门禁在旧接口真正
 * 下线时会因为"文件已不再引用"而报陈旧条目，逼着一起清理，避免白名单变成垃圾场。
 */
export const CALLER_ALLOWLIST: Record<string, string> = {
  "noj-ui/pages/editor/[id].vue":
    "旧竞赛编辑器分支：`legacy-contest-editor` 中间件在渲染前 301 到域作答页，分支不可达；随 0.12 下线一并删除",
  "noj-ui/utils/editorHistory.ts":
    "同上，仅被旧竞赛编辑器分支使用；随该分支一并删除",
};

/** 允许保留只读兼容的路由文件（声明侧，不是调用侧）。 */
const ROUTE_FILE = "noj-core/src/modules/contests/routes/contests.ts";
const RETIRED_FILE = "noj-core/src/modules/http/retired-endpoints.json";

/** 只需统计、不参与"生产调用方"判定的目录（测试与文档）。 */
const TEST_ROOTS = ["noj-tests/"];

export interface LegacyContestApiResult {
  errors: string[];
  inventory: RouteInventory;
  productionCallers: LegacyCaller[];
  testCallers: LegacyCaller[];
  staleAllowlist: string[];
}

const SCAN_DIRS = ["noj-ui", "noj-cli", "noj-lmcc-extension", "noj-core/src", "noj-tests"];
const SCAN_EXT = [".ts", ".vue"];
const SKIP_DIR_NAMES: RegExp[] = [
  /node_modules/,
  /\.nuxt/,
  /\.output/,
  /dist/,
  /\.deno_cache/,
];

function isTestPath(path: string): boolean {
  return /\/tests\//.test(path) || /_test\.ts$/.test(path) ||
    /\.test\.ts$/.test(path) || path.includes("noj-tests/");
}

async function collectSources(root: string): Promise<Array<
  { file: string; text: string; production: boolean }
>> {
  const result: Array<{ file: string; text: string; production: boolean }> = [];
  const walkRoot = (dir: string) =>
    walk(resolve(root, dir), {
      skip: SKIP_DIR_NAMES,
      includeDirs: false,
      exts: SCAN_EXT,
    });
  for (const dir of SCAN_DIRS) {
    try {
      for await (const entry of walkRoot(dir)) {
        const file = relative(resolve(root), entry.path).replaceAll("\\", "/");
        // 声明侧文件统计的是"路由存在"，不算调用方。
        if (file === ROUTE_FILE) continue;
        result.push({
          file,
          text: await Deno.readTextFile(entry.path),
          production: !isTestPath(file),
        });
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue;
      throw error;
    }
  }
  return result;
}

/** 执行检查；root 默认为仓库根。 */
export async function checkLegacyContestApi(
  root = ".",
): Promise<LegacyContestApiResult> {
  const errors: string[] = [];
  const routeSource = await Deno.readTextFile(resolve(root, ROUTE_FILE));
  const retired = JSON.parse(
    await Deno.readTextFile(resolve(root, RETIRED_FILE)),
  ) as RetiredEntry[];
  const retiredContest = retired.filter((entry) =>
    normalizeLegacyPath(entry.path).startsWith(LEGACY_CONTEST_PREFIX)
  );
  const declared = extractDeclaredRoutes(routeSource);
  const inventory = classifyRoutes(declared, retiredContest);

  if (declared.length === 0) {
    errors.push(
      `${ROUTE_FILE} 未解析到任何无域路由声明（正则已与写法脱节，门禁恒真）`,
    );
  }
  for (const route of inventory.writesNotRetired) {
    errors.push(
      `${route.method} ${normalizeLegacyPath(route.path)} 仍未退役：` +
        `写方法必须登记到 ${RETIRED_FILE}（否则部署到生产后旧入口仍可写）`,
    );
  }

  const sources = await collectSources(root);
  const allCallers = findLegacyCallers(
    sources.map(({ file, text }) => ({ file, text })),
  );
  const productionSet = new Set(
    sources.filter((s) => s.production).map((s) => s.file),
  );
  const productionCallers = allCallers.filter((caller) =>
    productionSet.has(caller.file)
  );
  const testCallers = allCallers.filter((caller) =>
    TEST_ROOTS.some((prefix) => caller.file.startsWith(prefix))
  );

  for (const caller of productionCallers) {
    if (!(caller.file in CALLER_ALLOWLIST)) {
      errors.push(
        `${caller.file}:${caller.line} 新增了无域比赛接口调用：${caller.snippet}` +
          `（该接口只保留只读兼容，请改用 /api/v1/domains/:slug/contests/...）`,
      );
    }
  }

  const referenced = new Set(productionCallers.map((caller) => caller.file));
  const staleAllowlist = Object.keys(CALLER_ALLOWLIST).filter((file) =>
    !referenced.has(file)
  );
  for (const file of staleAllowlist) {
    errors.push(
      `CALLER_ALLOWLIST 中的 ${file} 已不再引用无域比赛接口，请移除该条目` +
        `（旧接口下线时白名单必须同步清空）`,
    );
  }

  return {
    errors,
    inventory,
    productionCallers,
    testCallers,
    staleAllowlist,
  };
}

if (import.meta.main) {
  const { errors, inventory, productionCallers, testCallers } =
    await checkLegacyContestApi(".");
  if (errors.length > 0) {
    console.error("旧无域比赛 API 下线检查失败：");
    for (const error of errors) console.error(`- ${error}`);
    Deno.exit(1);
  }
  console.log(
    `旧无域比赛 API 检查通过（只读 ${inventory.reads.length} 条保留 / ` +
      `写 ${inventory.writesRetired.length} 条已退役 / ` +
      `生产调用方 ${productionCallers.length} 个均在白名单 / ` +
      `测试引用 ${testCallers.length} 处仅跑非生产环境）`,
  );
}
