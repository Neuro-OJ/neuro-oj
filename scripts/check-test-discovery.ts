/**
 * 测试文件可发现性检查。
 *
 * 背景（2026-09-11 评审）：本仓库的测试运行器按 Deno 的默认约定发现测试文件
 * （文件名需匹配 `*_test.ts` / `*.test.ts` / `*_test.tsx` 等），而部分测试任务是
 * 以**目录**为参数调用的（如 `scripts/test-shared.sh` 传 `tests/routes`、
 * `test-domain.sh` 传 `src/domains/<domain>/tests`）。
 *
 * 于是出现了一类静默失效：文件里写了 `Deno.test(...)`，但文件名不符合约定，
 * 运行时被**静默跳过**——本地与 CI 都显示绿色，零覆盖却无人察觉。
 * 实测案例：`noj-core/tests/routes/health.ts`（PR #484 新增）从未被执行过。
 *
 * 本脚本扫描所有含 `Deno.test(` 的文件，断言其文件名匹配运行器的发现模式；
 * 不匹配即失败并给出改名建议。
 */

import { resolve } from "node:path";

/**
 * Deno 测试运行器的默认发现模式。
 *
 * 依据 `deno test` 文档：匹配 `*.test.{ts,tsx,js,jsx,mjs}`、
 * `*_test.{ts,tsx,js,jsx,mjs}`、`*_test_*.{ts,tsx,...}` 以及 `test.{ts,...}`。
 * 这里只要求最常见的两种，避免把合法的 `*_test_*.ts` 误判——若要放宽，
 * 请与 Deno 文档同步而不是凭印象修改。
 */
const DISCOVERY_PATTERNS = [
  /\.test\.(ts|tsx|js|jsx|mjs)$/,
  /_test\.(ts|tsx|js|jsx|mjs)$/,
  /_test_[^/]*\.(ts|tsx|js|jsx|mjs)$/,
  /(^|\/)test\.(ts|tsx|js|jsx|mjs)$/,
];

/** 这些目录不参与扫描（第三方/构建产物/嵌套独立仓库/覆盖率缓存）。 */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".jj",
  "target",
  ".output",
  ".nuxt",
  ".deno_cache",
  ".deno_cov_cache",
  ".test-cache",
  ".test-storage",
  "data",
  "coverage",
  "dist",
  ".turbo",
]);

export interface UndiscoverableTest {
  /** 仓库相对路径。 */
  file: string;
  /** 文件内出现的 Deno.test 数量。 */
  testCount: number;
}

/** 文件名是否会被 Deno 测试运行器发现。 */
export function isDiscoverable(fileName: string): boolean {
  return DISCOVERY_PATTERNS.some((re) => re.test(fileName));
}

/**
 * 扫描目录树，返回「含 Deno.test 但不会被发现」的文件。
 *
 * @param root 仓库根
 * @param searchDir 相对 root 的起始目录
 */
export async function findUndiscoverableTests(
  root: string,
  searchDir: string,
): Promise<UndiscoverableTest[]> {
  const found: UndiscoverableTest[] = [];

  async function walk(absDir: string, relDir: string): Promise<void> {
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(absDir)];
    } catch {
      return; // 目录不存在：跳过（各模块可选）
    }
    for (const entry of entries) {
      if (entry.isDirectory) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(`${absDir}/${entry.name}`, `${relDir}/${entry.name}`);
        continue;
      }
      if (!entry.isFile) continue;
      if (!/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name)) continue;
      if (isDiscoverable(entry.name)) continue;

      const abs = `${absDir}/${entry.name}`;
      let content = "";
      try {
        content = await Deno.readTextFile(abs);
      } catch {
        continue;
      }
      // 只关心真的声明了测试的文件（工具/辅助模块不匹配是正常的）
      const testCount = content.match(/\bDeno\.test\s*\(/g)?.length ?? 0;
      if (testCount === 0) continue;

      // 排除「测试工厂」：把 Deno.test 包在导出函数里供其他测试调用的辅助模块
      // （如 noj-tests/e2e/helper.ts 的 e2eTest()）。这类文件的 Deno.test 调用
      // 位于函数体内，本身不应被发现——它们不是测试文件。
      // 判定：文件导出了函数/箭头函数，且没有顶层的 Deno.test( 调用。
      const hasTopLevelTest = /^(?!\s*(?:\/\/|\*)).*?\bDeno\.test\s*\(/m.test(
        content.split("\n").filter((l) => !/^\s/.test(l)).join("\n"),
      );
      if (!hasTopLevelTest) continue;

      found.push({ file: `${relDir}/${entry.name}`, testCount });
    }
  }

  await walk(resolve(root, searchDir), searchDir);
  return found;
}

/** 扫描仓库主要模块，返回全部不可发现的测试文件。 */
export async function checkTestDiscovery(
  root = ".",
): Promise<UndiscoverableTest[]> {
  const results: UndiscoverableTest[] = [];
  for (const dir of ["noj-core", "noj-ui", "noj-tests", "noj-llm-gateway"]) {
    results.push(...await findUndiscoverableTests(root, dir));
  }
  return results;
}

if (import.meta.main) {
  const found = await checkTestDiscovery(".");
  if (found.length > 0) {
    console.error(
      `发现 ${found.length} 个含 Deno.test 但**不会被测试运行器发现**的文件：\n`,
    );
    for (const f of found) {
      const suggestion = f.file.replace(/(\.(ts|tsx|js|jsx|mjs))$/, ".test$1");
      console.error(`- ${f.file}（${f.testCount} 个 Deno.test）`);
      console.error(`  这些用例永远不会执行，却在本地与 CI 都显示为绿色。`);
      console.error(`  建议改名为：${suggestion}\n`);
    }
    Deno.exit(1);
  }
  console.log("测试文件可发现性检查通过");
}
