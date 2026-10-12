/**
 * `deno compile` 导入安全门禁。
 *
 * 背景（2026-09-25 生产实测）：`deno compile` 只对**字面量**动态导入
 * （`import("./x.ts")`）做静态分析并内联模块；写成变量说明符
 * （`const p = "./x.ts"; await import(p)`）时编译期**不报错**，运行到那一行才抛
 * `Module not found: file:///tmp/deno-compile-noj-server/...`。
 *
 * 生产镜像（noj-server / noj-cli）是 `deno compile` 产物，因此这类缺陷：
 * - 本地 `deno task dev`（直接跑源码）全绿；
 * - 单元测试全绿（测试也跑源码）；
 * - CI 全绿（不执行编译产物中的那条分支）；
 * - **只在生产容器里炸**——`noj-server:0.10.1-alpha.2` 的阿里云邮件 Provider
 *   即因此不可用，注册/邮箱验证/找回密码全链路 500。
 *
 * 本门禁静态拦截该写法（扫描 `deno compile` 产物的源码根），并自带正/反例控制
 * 断言——解析规则一旦失效，门禁**失败**而不是静默通过（同类"假绿灯"治理见
 * `scripts/verify-capability-seams.ts`）。确需保留变量说明符的（例如运行时插件
 * 加载）必须登记进 `ALLOWED_NON_LITERAL` 并写明理由。
 */
import { relative, resolve } from "node:path";

const DEFAULT_REPO_ROOT = resolve(import.meta.dirname ?? ".", "..");

/** 生产产物是 `deno compile` 单文件的模块源码根（相对仓库根）。 */
export const COMPILE_TARGET_ROOTS: readonly string[] = [
  "noj-core/src",
  "noj-core/scripts",
  "noj-cli/src",
];

/**
 * 经评审确认必须保留变量说明符的例外（相对仓库根的路径 → 理由）。
 *
 * 当前为空：仓库内所有动态导入都是静态可分析的说明符。
 */
export const ALLOWED_NON_LITERAL: Readonly<Record<string, string>> = {};

/** 匹配 `import(` 调用（排除 `import.meta` / `foo.import(` / 标识符后缀）。 */
const DYNAMIC_IMPORT_RE = /(?<![\w.$])import\s*\(/g;

/** 单个非字面量动态导入。 */
export interface NonLiteralDynamicImport {
  /** 距文件开头的字符偏移。 */
  index: number;
  /** 1 起的行号。 */
  line: number;
  /** 括号内的原始实参文本（截断展示用）。 */
  argument: string;
}

/**
 * 把注释替换为等长空格，保留字符串字面量原样。
 *
 * 保留字符串是必须的：判定"实参是否为字面量"要看字符串本身。若直接把注释连同
 * 字符串中的 `//`（如 URL）一起丢掉，会误伤同一行后续的真实代码。
 */
export function maskComments(text: string): string {
  const out = text.split("");
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      while (i < n && text[i] !== "\n") out[i++] = " ";
      continue;
    }
    if (ch === "/" && next === "*") {
      out[i++] = " ";
      out[i++] = " ";
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] !== "\n") out[i] = " ";
        i++;
      }
      if (i < n) {
        out[i++] = " ";
        out[i++] = " ";
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < n) {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    i++;
  }
  return out.join("");
}

/** 是否为"字面量说明符"（单/双引号字符串，或**无插值**的模板字符串）。 */
export function isLiteralSpecifier(argument: string): boolean {
  const arg = argument.trim();
  if (arg.length < 2) return false;
  const quote = arg[0];
  if (quote !== '"' && quote !== "'" && quote !== "`") return false;
  if (arg[arg.length - 1] !== quote) return false;
  const body = arg.slice(1, -1);
  if (quote === "`" && body.includes("${")) return false;
  if (body.includes("\\")) return false;
  return !body.includes(quote);
}

/** 从 `(` 处取平衡括号内的实参文本（跳过括号内的字符串）。 */
function readArgument(masked: string, openParen: number): string {
  let depth = 0;
  let i = openParen;
  const n = masked.length;
  while (i < n) {
    const ch = masked[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < n) {
        if (masked[i] === "\\") {
          i += 2;
          continue;
        }
        if (masked[i] === quote) break;
        i++;
      }
      i++;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return masked.slice(openParen + 1, i);
    }
    i++;
  }
  return masked.slice(openParen + 1);
}

/** 扫描一段源码中的所有非字面量动态导入。 */
export function findNonLiteralDynamicImports(
  text: string,
): NonLiteralDynamicImport[] {
  const masked = maskComments(text);
  const found: NonLiteralDynamicImport[] = [];
  DYNAMIC_IMPORT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = DYNAMIC_IMPORT_RE.exec(masked)) !== null) {
    const openParen = match.index + match[0].length - 1;
    const argument = readArgument(masked, openParen);
    if (isLiteralSpecifier(argument)) continue;
    found.push({
      index: match.index,
      line: masked.slice(0, match.index).split("\n").length,
      argument: argument.trim().replace(/\s+/g, " ").slice(0, 80),
    });
  }
  return found;
}

export interface CompileSafeImportResult {
  errors: string[];
  stats: {
    scanned_files: number;
    dynamic_imports: number;
    violations: number;
  };
}

function collectTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of Deno.readDirSync(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      if (entry.name === "node_modules" || entry.name === ".deno_cache") {
        continue;
      }
      files.push(...collectTsFiles(path));
    } else if (entry.isFile && entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

/** 测试代码不编译进生产二进制，不受本规则约束。 */
function isTestFile(relPath: string): boolean {
  return relPath.includes("/tests/") || relPath.endsWith("_test.ts") ||
    relPath.endsWith(".test.ts");
}

/**
 * 解析器自检控制用例：字面量必须放行、变量说明符必须命中。
 *
 * 门禁最危险的失效形态是"规则恒真/恒假"——这里让规则自己在每次运行时证明
 * 它既能放行也能拦截，否则整体判失败。
 */
const CONTROLS: { source: string; expected: number; label: string }[] = [
  { source: `await import("./a.ts");`, expected: 0, label: "字面量（双引号）" },
  { source: `await import('./a.ts');`, expected: 0, label: "字面量（单引号）" },
  {
    source:
      `    const { cms }: any = await import(\n      "npm:x@^1.0.0"\n    );`,
    expected: 0,
    label: "多行字面量",
  },
  {
    source: `const p = "./a.ts";\nawait import(p);`,
    expected: 1,
    label: "变量说明符",
  },
  {
    source: "await import(`./a/" + "${name}.ts`);",
    expected: 1,
    label: "带插值的模板字符串",
  },
  {
    source: `await import.meta.resolve("./a.ts");`,
    expected: 0,
    label: "import.meta",
  },
  { source: `// await import(p);\n`, expected: 0, label: "注释中的调用" },
];

/** 执行校验。 */
export function verifyCompileSafeImports(
  repoRoot = DEFAULT_REPO_ROOT,
): CompileSafeImportResult {
  const errors: string[] = [];

  // 自检 1：控制用例必须同时具备放行与拦截能力
  for (const control of CONTROLS) {
    const hits = findNonLiteralDynamicImports(control.source).length;
    if (hits !== control.expected) {
      errors.push(
        `解析器自检失败（${control.label}）：期望 ${control.expected} 处命中，实际 ${hits}`,
      );
    }
  }

  // 自检 2：例外登记的文件必须真实存在
  for (const [rel, reason] of Object.entries(ALLOWED_NON_LITERAL)) {
    try {
      Deno.statSync(`${repoRoot}/${rel}`);
    } catch {
      errors.push(`例外登记的文件不存在：${rel}（理由：${reason}）`);
    }
  }

  let scanned = 0;
  let dynamicImports = 0;
  let violations = 0;

  for (const targetRoot of COMPILE_TARGET_ROOTS) {
    const abs = `${repoRoot}/${targetRoot}`;
    let files: string[];
    try {
      files = collectTsFiles(abs);
    } catch {
      errors.push(
        `扫描目录不存在：${targetRoot}（源码根漂移后门禁会静默失去检查对象）`,
      );
      continue;
    }
    if (files.length === 0) {
      errors.push(`扫描目录下没有任何 TS 文件：${targetRoot}`);
      continue;
    }
    for (const file of files) {
      const rel = relative(repoRoot, file);
      if (isTestFile(rel)) continue;
      scanned++;
      const text = Deno.readTextFileSync(file);
      const masked = maskComments(text);
      DYNAMIC_IMPORT_RE.lastIndex = 0;
      while (DYNAMIC_IMPORT_RE.exec(masked) !== null) dynamicImports++;
      if (ALLOWED_NON_LITERAL[rel]) continue;
      for (const hit of findNonLiteralDynamicImports(text)) {
        violations++;
        errors.push(
          `${rel}:${hit.line} 动态导入使用了变量说明符 import(${hit.argument})` +
            `——deno compile 无法内联，生产二进制运行到此处会抛 Module not found；` +
            `请改为字面量说明符（或在 ALLOWED_NON_LITERAL 登记理由）`,
        );
      }
    }
  }

  return {
    errors,
    stats: {
      scanned_files: scanned,
      dynamic_imports: dynamicImports,
      violations,
    },
  };
}

if (import.meta.main) {
  const { errors, stats } = verifyCompileSafeImports();
  if (errors.length > 0) {
    console.error("deno compile 导入安全校验失败：");
    for (const err of errors) console.error(`- ${err}`);
    Deno.exit(1);
  }
  console.log(
    `deno compile 导入安全校验通过（扫描 ${stats.scanned_files} 文件 / ` +
      `${stats.dynamic_imports} 处动态导入 / 0 处变量说明符）`,
  );
}
