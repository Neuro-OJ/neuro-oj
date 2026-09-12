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
  /** 扫描到的 .ts 文件数（门禁自检用，见 main） */
  files: number;
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
  return { exports, documented, coverage, files: 1 };
}

/** 聚合目录下所有 .ts 文件的覆盖率。 */
export function analyzeRoot(root: string): ExportDocStats {
  let exports = 0;
  let documented = 0;
  let files = 0;
  for (const filePath of collectTsFilesSync(root)) {
    const stats = analyzeFile(filePath);
    exports += stats.exports;
    documented += stats.documented;
    files++;
  }
  const coverage = exports === 0 ? 100 : (documented / exports) * 100;
  return { exports, documented, coverage, files };
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

// 目标目录 + 覆盖率阈值 + **导出数下限**。
//
// 下限的必要性（2026-09-12 架构评审 §2.3 同类缺陷）：`coverage` 在
// `exports === 0` 时被定义为 100%，于是"目录改名 / EXPORT_RE 与代码写法脱节 /
// 扫描器静默失效"都会得到 **100% 覆盖率并判定通过**——正是"假绿灯"。
// 有了下限断言，导出数骤降（而非归零）同样会被发现。
// 调整下限时必须是有意为之（随重构同步更新），不要为了"变绿"而下调。
const TARGETS = [
  { root: "noj-core/src", min: 59.6, minExports: 1000 },
  { root: "noj-llm-gateway/src", min: 69.4, minExports: 50 },
];

/** 仓库根目录（本脚本位于 <root>/scripts 下）。 */
const REPO_ROOT = new URL("../", import.meta.url).pathname;

if (import.meta.main) {
  let failed = false;
  for (const target of TARGETS) {
    const stats = analyzeRoot(REPO_ROOT + target.root);
    const shortName = target.root.split("/").pop() ?? target.root;
    console.log(
      `${target.root}: 文件 ${stats.files}，导出 ${stats.exports}，带 JSDoc ${stats.documented}，覆盖率 ${
        stats.coverage.toFixed(1)
      }%（阈值 ${target.min}%）`,
    );
    // 自检：扫描器必须真的扫到东西，否则"100% 通过"毫无意义
    if (stats.files === 0) {
      console.error(
        `  FAIL: ${target.root} 未扫描到任何 .ts 文件（路径或扫描器已失效）`,
      );
      failed = true;
      continue;
    }
    if (stats.exports === 0) {
      console.error(
        `  FAIL: ${target.root} 未解析到任何 export（EXPORT_RE 已与代码写法脱节，门禁恒真）`,
      );
      failed = true;
      continue;
    }
    if (stats.exports < target.minExports) {
      console.error(
        `  FAIL: ${target.root} 导出数 ${stats.exports} 低于下限 ${target.minExports}（解析可能部分失效）`,
      );
      failed = true;
      continue;
    }
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
