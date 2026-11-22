/**
 * 分支安全自检 · 检查项 B（断链引用）的语义解析。
 *
 * 负责三件事：从字符串字面量里挑出"值得解析"的引用、把它们映射成候选仓库内路径、
 * 逐个探测文件是否存在。词法扫描在 `branch-safety-lexer.ts`。
 *
 * 设计取舍（**宁可少报，也不要大量误报**）：
 * - 导入语句只认相对路径与 `~/` `@/` `~~/` `@@/` 别名（裸模块名、`#imports`、
 *   `npm:` / `jsr:` / `node:` 一律不管）；
 * - 字符串字面量只认「别名前缀」或「首段是仓库顶层目录」且带源码扩展名的形态，
 *   避免把 `/api/v1/x`、`https://...`、`assets/*.svg` 这类运行时路径当引用；
 * - **测试文件只查导入、不查字符串字面量**：测试里大量字面量是写到临时目录的
 *   夹具数据（实测 `scripts/` + `noj-tests/` 全量扫描的 40 处误报全部来自这类夹具）；
 * - 字符串的基准目录有歧义（仓库根 / 模块根 / 本文件目录），任一基准命中即算存在；
 * - 同一行或上下相邻行注释里写 `branch-safety: ignore` 可显式豁免（用于「这些
 *   路径本来就必须不存在」的断言常量）。
 */

import { scanStringTokens } from "./branch-safety-lexer.ts";
import type { TreeSource } from "./branch-safety-tree.ts";

/** 引用来源。 */
export type ReferenceKind = "import" | "dynamic-import" | "string";

/** 源码中的一处候选引用。 */
export interface SourceReference {
  /** 引号内的原始内容（别名尚未映射）。 */
  specifier: string;
  /** 1 起始的行号。 */
  line: number;
  kind: ReferenceKind;
}

/** 一条解析不到真实文件的引用。 */
export interface BrokenReference extends SourceReference {
  /** 出现该引用的文件（相对仓库根）。 */
  file: string;
  /** 归一化后的仓库内路径（别名已映射，取最可信的候选）。 */
  resolvedPath: string;
}

/** 引用扫描统计（零扫描守卫与报告共用）。 */
export interface ReferenceScanStats {
  /** 实际读取并扫描的文件数。 */
  scannedFiles: number;
  /** 读取失败而跳过的文件数（通常是分支里已删除的文件）。 */
  skippedFiles: number;
  /** 落在检查范围内的引用数。 */
  references: number;
  /** 不在检查范围内的字面量数（裸模块名、URL、目录名等）。 */
  outOfScope: number;
}

/**
 * 路径字面量只认这些扩展名。
 *
 * 刻意不收录 `.png` / `.svg` 等资源扩展名：Vue 模板里的资源引用常由构建器改写，
 * 误报成本远高于收益。
 */
export const PATH_EXTENSIONS: readonly string[] = [
  ".ts",
  ".tsx",
  ".mts",
  ".vue",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".css",
];

/** 无扩展名引用（Nuxt / TS 常见写法）的解析后缀，顺序即优先级。 */
const PROBE_SUFFIXES: readonly string[] = [
  ".ts",
  ".tsx",
  ".mts",
  ".vue",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  "/index.ts",
  "/index.tsx",
  "/index.vue",
  "/index.js",
];

/** 显式豁免标记：注释里出现它时，本行与上下各一行的字符串字面量不作检查。 */
const IGNORE_MARKER = "branch-safety: ignore";

/** 测试文件只查导入，不查字符串字面量（夹具数据会大量误报）。 */
export function isTestLikePath(path: string): boolean {
  return /(_test|\.test|\.spec)\.[a-z]+$/.test(path);
}

/** 判定字符串前面是不是 `from` / `import` / `import(` / `require(`。 */
function classifyPrefix(prefix: string): ReferenceKind | null {
  if (prefix.endsWith("import(")) return "dynamic-import";
  if (prefix.endsWith("require(")) return "import";
  if (prefix.endsWith("from") || prefix.endsWith("import")) return "import";
  return null;
}

/** 导入语句里只有相对路径与 Nuxt 别名值得解析。 */
function isRelativeOrAlias(specifier: string): boolean {
  return specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier.startsWith("~/") ||
    specifier.startsWith("@/") ||
    specifier.startsWith("~~/") ||
    specifier.startsWith("@@/");
}

/**
 * 判断普通字符串是否"看起来是仓库内路径"。
 *
 * 只认两种形态：别名前缀，或路径里出现仓库顶层目录名（如 `noj-ui/utils/x.ts`）。
 * 需要同时带源码扩展名，避免把 `assets/*.svg`、`/api/v1/x` 当成引用。
 */
function looksLikeRepoPathLiteral(
  value: string,
  topLevel: ReadonlySet<string>,
): boolean {
  if (value.length === 0 || value.length > 240) return false;
  if (/[\s*?<>{}"'`|$]/.test(value)) return false;
  if (value.startsWith("/") || value.startsWith("#")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return false;
  const lower = value.toLowerCase();
  if (!PATH_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
    return false;
  }
  if (isRelativeOrAlias(value) && !value.startsWith("./")) return true;
  return value.split("/").some((segment) => topLevel.has(segment));
}

/**
 * 收集被 `branch-safety: ignore` 豁免的行（本行与上下各一行）。
 *
 * 上下各一行是刻意的：豁免通常写成尾注（同一行）或数组/常量上方的说明。
 */
function suppressedLines(source: string): Set<number> {
  const lines = new Set<number>();
  const rows = source.split("\n");
  for (let index = 0; index < rows.length; index++) {
    if (!rows[index].includes(IGNORE_MARKER)) continue;
    const line = index + 1;
    lines.add(line - 1);
    lines.add(line);
    lines.add(line + 1);
  }
  return lines;
}

/**
 * 从源码中抽取候选引用。
 *
 * `topLevel` 是仓库根下的顶层条目集合，用于识别"仓库内路径"形态的字符串字面量；
 * `stringLiterals` 为 false 时只抽导入语句（测试文件走这条路）。
 */
export function extractReferences(
  source: string,
  topLevel: ReadonlySet<string>,
  options: { stringLiterals?: boolean } = {},
): SourceReference[] {
  const includeLiterals = options.stringLiterals ?? true;
  const suppressed = includeLiterals
    ? suppressedLines(source)
    : new Set<number>();
  const references: SourceReference[] = [];
  for (const token of scanStringTokens(source)) {
    const kind = classifyPrefix(token.prefix);
    if (kind !== null) {
      if (isRelativeOrAlias(token.value)) {
        references.push({ specifier: token.value, line: token.line, kind });
      }
      continue;
    }
    if (!includeLiterals) continue;
    if (suppressed.has(token.line)) continue;
    if (looksLikeRepoPathLiteral(token.value, topLevel)) {
      references.push({
        specifier: token.value,
        line: token.line,
        kind: "string",
      });
    }
  }
  return references;
}

/**
 * 归一化路径：消掉 `.` / `..`，逃出仓库根时返回 null。
 *
 * 不用 `node:path`：脚本要在纯 Deno 下运行，且这里只处理 POSIX 形式的引用。
 */
export function normalizePath(path: string): string | null {
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  if (segments.length === 0) return null;
  return segments.join("/");
}

/** 文件所属模块的根目录（路径首段），用于字符串字面量的第二基准。 */
function moduleRootOf(fromFile: string): string | null {
  const slash = fromFile.indexOf("/");
  return slash === -1 ? null : fromFile.slice(0, slash);
}

/**
 * 把一处引用解析成候选仓库内路径（按可信度排序，可能为空 = 不在检查范围）。
 *
 * 导入语句只按「相对文件」或「别名」解析；普通字符串额外接受「仓库根」与
 * 「模块根」两个基准——字符串的基准目录本来就有歧义，多给候选可以明显降噪。
 */
export function resolveSpecifier(
  specifier: string,
  fromFile: string,
  topLevel: ReadonlySet<string>,
  kind: ReferenceKind = "import",
): string[] {
  if (specifier.startsWith("#")) return [];
  let target = specifier;
  const cut = target.search(/[?#]/);
  if (cut === 0) return [];
  if (cut > 0) target = target.slice(0, cut);

  const candidates: string[] = [];
  const push = (value: string | null): void => {
    if (value !== null && !candidates.includes(value)) candidates.push(value);
  };
  const moduleRoot = moduleRootOf(fromFile);

  if (target.startsWith("~~/") || target.startsWith("@@/")) {
    push(normalizePath(target.slice(3)));
    return candidates;
  }
  if (target.startsWith("~/") || target.startsWith("@/")) {
    push(normalizePath(`noj-ui/${target.slice(2)}`));
    return candidates;
  }

  const slash = fromFile.lastIndexOf("/");
  const directory = slash === -1 ? "" : fromFile.slice(0, slash + 1);

  if (target.startsWith("./") || target.startsWith("../")) {
    push(normalizePath(directory + target));
    if (kind !== "string") return candidates;
    // 字符串的基准有歧义：再试"仓库根相对"与"模块根相对"。
    const stripped = target.replace(/^(\.\.\/|\.\/)+/, "");
    push(normalizePath(stripped));
    if (moduleRoot !== null) push(normalizePath(`${moduleRoot}/${stripped}`));
    return candidates;
  }

  if (topLevel.has(target.split("/")[0])) {
    push(normalizePath(target));
    if (kind === "string" && moduleRoot !== null) {
      push(normalizePath(`${moduleRoot}/${target}`));
    }
    return candidates;
  }
  return [];
}

/**
 * 逐个候选探测：无扩展名的引用按 PROBE_SUFFIXES 补齐。
 *
 * 命中目录也算存在——目录形式的引用（如别名指向目录）是否合法由构建器判断，
 * 这里不制造额外噪声。
 */
async function probeReference(
  relativePath: string,
  exists: (relativePath: string) => Promise<boolean>,
): Promise<boolean> {
  if (await exists(relativePath)) return true;
  const name = relativePath.split("/").pop() ?? "";
  if (/\.[a-z0-9]+$/i.test(name)) return false;
  for (const suffix of PROBE_SUFFIXES) {
    if (await exists(relativePath + suffix)) return true;
  }
  return false;
}

/**
 * 检查一批文件里的断链引用。
 *
 * 内容与存在性都从提交树取（`tree`），不读工作区；单测里传入内存实现的
 * `TreeSource` 即可脱离真实仓库。
 */
export async function checkBrokenReferences(options: {
  tree: TreeSource;
  files: readonly string[];
}): Promise<{ broken: BrokenReference[]; stats: ReferenceScanStats }> {
  const topLevel = await options.tree.topLevel();
  const exists = (relativePath: string) => options.tree.exists(relativePath);
  const stats: ReferenceScanStats = {
    scannedFiles: 0,
    skippedFiles: 0,
    references: 0,
    outOfScope: 0,
  };
  const broken: BrokenReference[] = [];

  for (const file of options.files) {
    const source = await options.tree.readFile(file);
    if (source === null) {
      stats.skippedFiles++;
      continue;
    }
    stats.scannedFiles++;
    for (
      const reference of extractReferences(source, topLevel, {
        stringLiterals: !isTestLikePath(file),
      })
    ) {
      const candidates = resolveSpecifier(
        reference.specifier,
        file,
        topLevel,
        reference.kind,
      );
      if (candidates.length === 0) {
        stats.outOfScope++;
        continue;
      }
      stats.references++;
      let found = false;
      for (const candidate of candidates) {
        if (await probeReference(candidate, exists)) {
          found = true;
          break;
        }
      }
      if (found) continue;
      broken.push({ ...reference, file, resolvedPath: candidates[0] });
    }
  }

  broken.sort((a, b) =>
    a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1
  );
  return { broken, stats };
}
