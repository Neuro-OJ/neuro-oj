/**
 * 无域比赛 API 已下线的守门检查（0.11）。
 *
 * 0.11 是激进收敛：旧 `/api/v1/contests/*`（详情、赛题、榜单、我的提交、报名、
 * 提交、答疑、SSE）**整体删除**，没有 301、没有 410、没有退役清单条目——路由不存在
 * 就是不存在。全域入口是 `/api/v1/domains/:slug/contests/...`。
 *
 * 本门禁只断言三件会真正退化的事：
 *
 * 1. **路由文件不得复活**：`noj-core/src/modules/contests/routes/contests.ts` 与
 *    `routes/index.ts` 一旦重新出现，说明有人把无域路由挂回来了。
 * 2. **不得再有任何第一方引用**：UI / CLI / IDE 插件 / core / E2E 里出现
 *    `/api/v1/contests` 都会在 0.11 变成 404，属于回归。
 * 3. **退役清单不得重新登记比赛**：既然处理函数已删除，退役条目只会误导"还有人调"。
 *
 * 只做只读检查。
 */
import { walk } from "jsr:@std/fs@^1";
import { relative, resolve } from "node:path";

/** 无域比赛前缀；0.11 起必须完全不存在。 */
export const LEGACY_CONTEST_PREFIX = "/api/v1/contests";

/** 已删除的无域路由文件：出现即回归。 */
export const DELETED_ROUTE_FILES = [
  "noj-core/src/modules/contests/routes/contests.ts",
  "noj-core/src/modules/contests/routes/index.ts",
];

const RETIRED_FILE = "noj-core/src/modules/http/retired-endpoints.json";

/** 扫描范围：所有可能调用该接口的第一方代码。 */
const SCAN_DIRS = [
  "noj-ui",
  "noj-cli",
  "noj-lmcc-extension",
  "noj-core/src",
  "noj-tests",
];
const SCAN_EXT = [".ts", ".vue"];
const SKIP_DIR_NAMES: RegExp[] = [
  /node_modules/,
  /\.nuxt/,
  /\.output/,
  /dist/,
  /\.deno_cache/,
];

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

export interface LegacyContestApiResult {
  errors: string[];
  callers: LegacyCaller[];
  scannedFiles: number;
}

async function collectSources(
  root: string,
): Promise<Array<{ file: string; text: string }>> {
  const result: Array<{ file: string; text: string }> = [];
  for (const dir of SCAN_DIRS) {
    try {
      for await (
        const entry of walk(resolve(root, dir), {
          skip: SKIP_DIR_NAMES,
          includeDirs: false,
          exts: SCAN_EXT,
        })
      ) {
        result.push({
          file: relative(resolve(root), entry.path).replaceAll("\\", "/"),
          text: await Deno.readTextFile(entry.path),
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

  for (const file of DELETED_ROUTE_FILES) {
    try {
      await Deno.stat(resolve(root, file));
      errors.push(`${file} 重新出现：无域比赛路由必须保持删除状态`);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }

  const retired = JSON.parse(
    await Deno.readTextFile(resolve(root, RETIRED_FILE)),
  ) as Array<{ method: string; path: string }>;
  const contestEntries = retired.filter((entry) =>
    entry.path.startsWith(LEGACY_CONTEST_PREFIX)
  );
  for (const entry of contestEntries) {
    errors.push(
      `${RETIRED_FILE} 仍登记 ${entry.method} ${entry.path}：` +
        `该路由已删除，退役条目会误导读者以为接口还在`,
    );
  }

  const sources = await collectSources(root);
  const callers = findLegacyCallers(sources);
  for (const caller of callers) {
    errors.push(
      `${caller.file}:${caller.line} 仍引用无域比赛接口：${caller.snippet}` +
        `（0.11 起该路径不存在，请改用 /api/v1/domains/:slug/contests/...）`,
    );
  }

  return { errors, callers, scannedFiles: sources.length };
}

if (import.meta.main) {
  const { errors, callers, scannedFiles } = await checkLegacyContestApi(".");
  if (errors.length > 0) {
    console.error("无域比赛 API 下线检查失败：");
    for (const error of errors) console.error(`- ${error}`);
    Deno.exit(1);
  }
  console.log(
    `无域比赛 API 下线检查通过（扫描 ${scannedFiles} 个文件，` +
      `路由文件保持删除，第一方引用 ${callers.length} 处，退役清单无比赛条目）`,
  );
}
