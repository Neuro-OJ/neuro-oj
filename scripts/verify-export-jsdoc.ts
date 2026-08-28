// 导出 JSDoc 覆盖率门禁。
// 统计指定目录下 .ts 导出声明中带 /** */ 的比例，低于阈值时退出非零。

/** 导出声明匹配：export [async] function/class/interface/type/enum/abstract class/const <name> */
const EXPORT_RE =
  /export\s+(?:async\s+)?(?:function|class|interface|type|enum|abstract\s+class|const)\s+([A-Za-z_$][\w$]*)/;

/** 向前查找 JSDoc 的最大非空行数。 */
const DOC_LOOKBACK = 6;

export interface ExportDocStats {
  exports: number;
  documented: number;
  coverage: number;
}

function hasPrecedingJsdoc(lines: string[], index: number): boolean {
  let nonEmptySeen = 0;
  for (let i = index - 1; i >= 0 && nonEmptySeen < DOC_LOOKBACK; i--) {
    const line = lines[i].trim();
    if (line === "") {
      continue;
    }
    nonEmptySeen++;
    if (line.startsWith("/**")) {
      return true;
    }
    // 遇到非 JSDoc 代码（如装饰器/上一声明）则不再向上找
    if (!line.startsWith("*") && !line.startsWith("/*")) {
      return false;
    }
  }
  return false;
}

/** 分析单个文件。 */
export function analyzeFile(filePath: string): ExportDocStats {
  const text = Deno.readTextFileSync(filePath);
  const lines = text.split(/\r?\n/);
  let exports = 0;
  let documented = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!EXPORT_RE.test(line)) {
      continue;
    }
    exports++;
    if (hasPrecedingJsdoc(lines, i)) {
      documented++;
    }
  }

  const coverage = exports === 0 ? 100 : (documented / exports) * 100;
  return { exports, documented, coverage };
}

/** 聚合目录下所有 .ts 文件的覆盖率。 */
export function analyzeRoot(root: string): ExportDocStats {
  let exports = 0;
  let documented = 0;
  for (const filePath of collectTsFilesSync(root)) {
    const stats = analyzeFile(filePath);
    exports += stats.exports;
    documented += stats.documented;
  }
  const coverage = exports === 0 ? 100 : (documented / exports) * 100;
  return { exports, documented, coverage };
}

function collectTsFilesSync(dir: string): string[] {
  const files: string[] = [];
  for (const entry of Deno.readDirSync(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      files.push(...collectTsFilesSync(path));
    } else if (
      entry.isFile && entry.name.endsWith(".ts") &&
      !entry.name.endsWith("_test.ts")
    ) {
      files.push(path);
    }
  }
  return files;
}

/** 是否低于最低覆盖率阈值。 */
export function isBelowThreshold(
  stats: ExportDocStats,
  minCoverage: number,
): boolean {
  return stats.coverage < minCoverage;
}

const TARGETS = [
  { root: "noj-core/src", min: 59.6 },
  { root: "noj-llm-gateway/src", min: 69.4 },
];

/** 仓库根目录（本脚本位于 <root>/scripts 下）。 */
const REPO_ROOT = new URL("../", import.meta.url).pathname;

if (import.meta.main) {
  let failed = false;
  for (const target of TARGETS) {
    const stats = analyzeRoot(REPO_ROOT + target.root);
    const shortName = target.root.split("/").pop() ?? target.root;
    console.log(
      `${target.root}: 导出 ${stats.exports}，带 JSDoc ${stats.documented}，覆盖率 ${
        stats.coverage.toFixed(1)
      }%（阈值 ${target.min}%）`,
    );
    if (isBelowThreshold(stats, target.min)) {
      console.error(`  FAIL: ${shortName} 低于 JSDoc 覆盖率阈值`);
      failed = true;
    }
  }
  if (failed) {
    Deno.exit(1);
  }
  console.log("导出 JSDoc 覆盖率门禁通过");
}
