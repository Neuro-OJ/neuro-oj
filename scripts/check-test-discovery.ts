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

      // 排除「测试工厂」（把 Deno.test 包在导出函数里供其他测试调用的辅助模块，
      // 如 noj-tests/e2e/helper.ts 的 e2eTest()）。判定见 hasFileLevelTest。
      if (!hasFileLevelTest(content)) continue;

      found.push({ file: `${relDir}/${entry.name}`, testCount });
    }
  }

  await walk(resolve(root, searchDir), searchDir);
  return found;
}

/**
 * 判断文件内是否存在**文件级** `Deno.test(...)` 调用。
 *
 * 背景（2026-09-21 修复）：此前用「剔除所有以空白开头的行，再看剩余是否有
 * `Deno.test(`」来排除"测试工厂"（如 `noj-tests/e2e/helper.ts` 的 `e2eTest()`）。
 * 该启发式把**所有缩进行**都当函数体，于是把 `Deno.test` 写在缩进块里的真实
 * 测试文件也一并放过——例如：
 *
 * ```ts
 * // noj-core/tests/routes/health2.ts（文件名不可发现）
 * for (const c of ["a", "b"]) {
 *   Deno.test(`case ${c}`, () => {});
 * }
 * ```
 *
 * 该文件既不会被运行器发现，也不会被本门禁标记，正是本门禁要防的"写了测试却
 * 永不执行、本地与 CI 都显示绿色"。
 *
 * 新判定：扫描源码（跳过字符串与注释），记录每个 `Deno.test(` 所在块的**开括号
 * 是否属于函数体**。只要存在一个不在函数体内的调用，就视为文件级测试。
 * 这样既保留"工厂排除"（helper.ts 的调用在 `e2eTest` 函数体内），又能发现
 * 顶层与控制流块（for/if/try）里的测试。
 */
export function hasFileLevelTest(content: string): boolean {
  let i = 0;
  const n = content.length;
  // 每个未闭合的 `{` 对应一个栈项：true 表示该块是函数体。
  const braceIsFunction: boolean[] = [];
  // 与之等长的栈项：该函数体的 `{` 在源码中的下标（非函数块为 -1）。
  const braceOpenIndex: number[] = [];
  // 每个 `{` → 匹配的 `}` 的下标（第一遍预扫描填充）。
  const matchOf = new Map<number, number>();
  const openStack: number[] = [];

  /** 判断某个 `{` 之前的片段是否像函数体开头。 */
  const looksLikeFunctionBrace = (before: string): boolean => {
    const tail = before.slice(-400);
    return (
      // function 声明/表达式、箭头函数、构造器
      /(?:function\b[^;{}()]*\([^;{}]*\)|\([^;{}]*\)\s*=>|=>|\bconstructor\b)\s*$/
        .test(tail) ||
      // `function foo(` 之后到 `{` 之间可能是返回类型注解
      /\bfunction\b[^;{]*$/.test(tail) ||
      // **方法简写 / class 方法**（评审发现的误判）：
      //   `const suite = { register(name) { Deno.test(...) } }`
      //   `class Suite { add(name) { Deno.test(...) } }`
      // 这类 `{` 同样属于函数体，此前会被判定为"文件级测试"→ 把合法测试工厂
      // 报成不可发现（误红）。反向匹配"标识符/属性名 + 参数表 + 可选返回注解 +
      // 行尾"，并排除控制流关键字（`if (x) {`、`for (…) {` 等不是函数体）。
      /(?<![.\w])(?!if\b|for\b|while\b|switch\b|catch\b|return\b|do\b|else\b|typeof\b|new\b|function\b)[A-Za-z_$][\w$]*\s*\([^;{}]*\)(\s*:\s*[^;{}()]+)?\s*$/
        .test(tail)
    );
  };

  /**
   * 该函数体是否是**立即调用**的函数表达式（IIFE）。
   *
   * 评审发现的漏判：`(() => { Deno.test("x", …) })()` 里的用例**确实会执行**，
   * 但它所在文件若命名不可发现就永远不会被运行器加载——此前因为"在函数体内"
   * 而被放过（真漏判）。判定方式：找到与函数体 `{` 匹配的 `}`，跳过其后的
   * `)`（包裹括号）与空白，若下一个字符是 `(`（或 `.call(` / `.apply(`），
   * 则该函数被立即调用。
   *
   * 已知局限（与旧实现一致）：`function make() { Deno.test(…) } make();` 这种
   * "先定义、后另行调用"的形态仍会被当作工厂放过——完整判定需要作用域分析，
   * 超出本门禁的成本预算；该形态在仓库中不存在。
   */
  const isImmediatelyInvoked = (openIndex: number): boolean => {
    const close = matchOf.get(openIndex);
    if (close === undefined) return false;
    let j = close + 1;
    while (j < n && /[\s)]/.test(content[j]!)) j++;
    if (content[j] === "(") return true;
    return content.startsWith(".call(", j) || content.startsWith(".apply(", j);
  };

  // ── 第一遍：建立 `{` → `}` 配对表（跳过注释与字符串）──
  {
    let k = 0;
    while (k < n) {
      const ch = content[k];
      if (ch === "/" && content[k + 1] === "/") {
        const nl = content.indexOf("\n", k);
        k = nl === -1 ? n : nl + 1;
        continue;
      }
      if (ch === "/" && content[k + 1] === "*") {
        const end = content.indexOf("*/", k + 2);
        k = end === -1 ? n : end + 2;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        const quote = ch;
        k++;
        while (k < n) {
          if (content[k] === "\\") k += 2;
          else if (content[k] === quote) {
            k++;
            break;
          } else k++;
        }
        continue;
      }
      if (ch === "{") openStack.push(k);
      else if (ch === "}") {
        const open = openStack.pop();
        if (open !== undefined) matchOf.set(open, k);
      }
      k++;
    }
  }

  while (i < n) {
    const ch = content[i];
    // 跳过行注释
    if (ch === "/" && content[i + 1] === "/") {
      const nl = content.indexOf("\n", i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    // 跳过块注释
    if (ch === "/" && content[i + 1] === "*") {
      const end = content.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    // 跳过字符串/模板字面量（粗粒度：忽略嵌套与转义带来的极端情况）
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < n) {
        if (content[i] === "\\") i += 2;
        else if (content[i] === quote) {
          i++;
          break;
        } else i++;
      }
      continue;
    }

    if (ch === "{") {
      const isFunction = looksLikeFunctionBrace(content.slice(0, i));
      braceIsFunction.push(isFunction);
      braceOpenIndex.push(isFunction ? i : -1);
      i++;
      continue;
    }
    if (ch === "}") {
      braceIsFunction.pop();
      braceOpenIndex.pop();
      i++;
      continue;
    }

    if (content.startsWith("Deno.test", i)) {
      const after = content.slice(i + "Deno.test".length);
      if (/^\s*\(/.test(after)) {
        // 不在任何函数体内 → 文件级测试。
        // 在函数体内但该函数是 IIFE（立即调用）→ 同样会在加载时执行，
        // 因此也算"文件级"（文件被运行器加载时就会跑）。
        const inFactory = braceIsFunction.some((isFn, depth) =>
          isFn && !isImmediatelyInvoked(braceOpenIndex[depth]!)
        );
        if (!inFactory) return true;
      }
    }
    i++;
  }
  return false;
}

/** 扫描仓库主要模块，返回全部不可发现的测试文件。 */
export async function checkTestDiscovery(
  root = ".",
): Promise<UndiscoverableTest[]> {
  const results: UndiscoverableTest[] = [];
  // 2026-09-21：补上 `noj-cli`。它是正式模块（44 个测试文件），此前不在扫描根内
  // → 其中的「写了 Deno.test 但文件名不被运行器发现」永远不会被本门禁抓到。
  for (
    const dir of [
      "noj-core",
      "noj-ui",
      "noj-tests",
      "noj-llm-gateway",
      "noj-cli",
    ]
  ) {
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
