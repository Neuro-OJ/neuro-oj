/**
 * 无域写接口「已彻底移除」的门禁（0.11）。
 *
 * 0.11 是激进收敛：旧无域写入口不再保留 301/410 兼容层，也没有退役清单——
 * 处理函数删除后，路径就是不存在。全域入口是 `/api/v1/domains/:slug/...`。
 *
 * 本门禁断言四件会真正退化的事：
 *
 * 1. **退役清单机制不得复活**：`retired-endpoints.json` / `retired-endpoints.ts` /
 *    `retireLegacyEndpoints` 一旦重新出现，说明又回到"登记式退役"。
 * 2. **无域写前缀不得被第一方生产代码引用**：UI / CLI / IDE 插件 / core 生产代码里
 *    出现这些前缀都会在运行时变成 404。
 * 3. **只读兼容面仍允许**：`GET /problems/:id`、`GET /trainings/:id` 等读端点还在，
 *    因此扫描只针对写前缀的**非 GET** 使用；测试文件不参与判定（它们用读端点做准备）。
 *
 * 只做只读检查。
 */
import { walk } from "jsr:@std/fs@^1";
import { relative, resolve } from "node:path";

/** 已删除的无域写前缀：出现即回归。 */
export const REMOVED_WRITE_PREFIXES = [
  "/api/v1/contests",
  "/api/v1/trainings",
  "/api/v1/submissions",
  "/api/v1/self-tests",
  "/api/v1/submission-upgrade-jobs",
  "/api/v1/problems",
];

/** 必须保持不存在的机制文件。 */
export const REMOVED_MECHANISM_FILES = [
  "noj-core/src/modules/http/retired-endpoints.json",
  "noj-core/src/modules/http/retired-endpoints.ts",
];

/** 必须消失的开关标识。 */
export const REMOVED_FLAGS = ["retireLegacyEndpoints", "ENDPOINT_RETIRED"];

const SCAN_DIRS = [
  "noj-ui",
  "noj-cli",
  "noj-lmcc-extension",
  "noj-core/src",
];
/** 指标/告警定义里出现的是**路径正则串**（PromQL label），不是 API 调用。 */
const SKIP_PATH_FRAGMENTS = [
  /^noj-core\/src\/modules\/platform\/observability\//,
];
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
    /\.test\.ts$/.test(path);
}

/** 剥离注释，保留行数（行号仍可对齐）。 */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/^\s*\/\/.*$/gm, (line) => " ".repeat(line.length));
}

export interface Offense {
  file: string;
  line: number;
  snippet: string;
}

/**
 * 判断一行是否是**写**用法：同一行里前缀附近出现写方法。
 *
 * 读端点仍在（如 `GET /problems/:id`），所以不能一见到前缀就报错。
 */
export function isWriteUsage(line: string, prefix: string): boolean {
  const idx = line.indexOf(prefix);
  if (idx < 0) return false;
  const around = line.slice(Math.max(0, idx - 80), idx + prefix.length + 80);
  if (
    /\b(GET|HEAD)\b/.test(around) && !/\b(POST|PUT|PATCH|DELETE)\b/.test(around)
  ) {
    return false;
  }
  return /\b(POST|PUT|PATCH|DELETE)\b/.test(around) ||
    /api\.(post|put|patch|delete)|apiPost|apiPut|apiPatch|apiDelete/.test(
      around,
    );
}

/** 在给定文件内容中查找无域写前缀的写用法（已剥离注释）。 */
export function findWriteUsages(
  files: Array<{ file: string; text: string }>,
): Offense[] {
  const offenses: Offense[] = [];
  for (const { file, text } of files) {
    const lines = stripComments(text).split("\n");
    lines.forEach((line, index) => {
      for (const prefix of REMOVED_WRITE_PREFIXES) {
        if (line.includes(prefix) && isWriteUsage(line, prefix)) {
          offenses.push({ file, line: index + 1, snippet: line.trim() });
          break;
        }
      }
    });
  }
  return offenses;
}

export interface LegacyApiRemovedResult {
  errors: string[];
  offenses: Offense[];
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
        const file = relative(resolve(root), entry.path).replaceAll("\\", "/");
        if (isTestPath(file)) continue;
        if (SKIP_PATH_FRAGMENTS.some((re) => re.test(file))) continue;
        result.push({ file, text: await Deno.readTextFile(entry.path) });
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue;
      throw error;
    }
  }
  return result;
}

/** 执行检查；root 默认为仓库根。 */
export async function checkLegacyApiRemoved(
  root = ".",
): Promise<LegacyApiRemovedResult> {
  const errors: string[] = [];

  for (const file of REMOVED_MECHANISM_FILES) {
    try {
      await Deno.stat(resolve(root, file));
      errors.push(`${file} 重新出现：退役清单机制在 0.11 已整体删除`);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }

  const sources = await collectSources(root);
  for (const source of sources) {
    const text = stripComments(source.text);
    for (const flag of REMOVED_FLAGS) {
      if (text.includes(flag)) {
        errors.push(
          `${source.file} 仍引用 ${flag}：登记式退役开关/错误码已删除`,
        );
      }
    }
  }

  const offenses = findWriteUsages(sources);
  for (const offense of offenses) {
    errors.push(
      `${offense.file}:${offense.line} 仍调用无域写接口：${offense.snippet}`,
    );
  }

  return { errors, offenses, scannedFiles: sources.length };
}

if (import.meta.main) {
  const { errors, offenses, scannedFiles } = await checkLegacyApiRemoved(".");
  if (errors.length > 0) {
    console.error("无域写接口下线检查失败：");
    for (const error of errors) console.error(`- ${error}`);
    Deno.exit(1);
  }
  console.log(
    `无域写接口下线检查通过（扫描 ${scannedFiles} 个生产文件，` +
      `退役机制不存在，写路径引用 ${offenses.length} 处）`,
  );
}
