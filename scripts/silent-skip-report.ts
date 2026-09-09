/**
 * 静默跳过扫描：找出测试中因 ignore / 环境变量守卫 / 测试体内提前 return
 * 而未真正执行的用例。
 *
 * 背景：E2E 与 DB 测试大量使用 `if (!isE2E) return;`、`if (!judgeOk) return;`、
 * `e2eTest(name, fn, extraIgnore)` 等写法——它们在报告里显示为 "ok"，
 * 但实际什么都没验证。本脚本把这些模式列出来，避免「零测试执行的假绿」。
 */
export interface SkipHit {
  file: string;
  line: number;
  reason:
    | "ignore"
    | "env-guard"
    | "early-return"
    | "rust-ignore"
    | "rust-env-guard";
}

/** 单行匹配规则（顺序即报告中的命中顺序）。 */
const LINE_RULES: Array<{ re: RegExp; reason: SkipHit["reason"] }> = [
  { re: /\bignore\s*:\s*true\b/, reason: "ignore" },
  { re: /\bignore\s*:\s*!/, reason: "ignore" },
  { re: /\bignore\s*:\s*Deno\.env\.get/, reason: "env-guard" },
  { re: /\bif\s*\(!?Deno\.env\.get\(/, reason: "env-guard" },
  // 测试体内提前返回：if (!isE2E) return; / if (!isE2E || !judgeOk) return;
  { re: /\bif\s*\(\s*!\s*isE2E\b/, reason: "early-return" },
  { re: /console\.log\([^)]*跳过/, reason: "early-return" },
  { re: /^\s*#\[ignore\]/, reason: "rust-ignore" },
  { re: /if\s+!\s*is_e2e_enabled\(\)/, reason: "rust-env-guard" },
];

export function scanFile(file: string, source: string): SkipHit[] {
  const hits: SkipHit[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const rule of LINE_RULES) {
      if (rule.re.test(line)) {
        hits.push({ file, line: i + 1, reason: rule.reason });
        break;
      }
    }
  }
  return hits;
}

export function renderReport(hits: SkipHit[]): string {
  const lines = [
    "# 静默跳过测试清单",
    "",
    "> 由 `deno run -A scripts/silent-skip-report.ts` 生成；",
    "> 命中 `ignore` / 环境变量守卫 / 测试体内提前 return / Rust `#[ignore]`。",
    "",
    "| 文件 | 行号 | 原因 |",
    "|---|---|---|",
  ];
  for (const h of hits) {
    lines.push(`| ${h.file} | ${h.line} | ${h.reason} |`);
  }
  return lines.join("\n") + "\n";
}

const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".nuxt",
  ".output",
  "dist",
  "coverage",
  ".deno_cov_cache",
  "target",
  ".git",
  ".jj",
]);

/** 是否是需要扫描的测试文件（含被测试 import 的 helper / setup 模块）。 */
function isTestFile(name: string): boolean {
  return /(_test|\.test)\.ts$/.test(name) ||
    /^(helper|_setup)\.ts$/.test(name) ||
    name.endsWith(".rs");
}

async function collectFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isDirectory) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        await walk(`${dir}/${entry.name}`);
      } else if (entry.isFile && isTestFile(entry.name)) {
        out.push(`${dir}/${entry.name}`);
      }
    }
  }
  await walk(root);
  return out;
}

async function collectHits(): Promise<SkipHit[]> {
  const hits: SkipHit[] = [];
  const roots = [
    "noj-core",
    "noj-ui",
    "noj-llm-gateway",
    "noj-tests",
    "noj-judge",
  ];
  for (const root of roots) {
    for (const file of await collectFiles(root)) {
      const source = await Deno.readTextFile(file);
      hits.push(...scanFile(file, source));
    }
  }
  return hits;
}

if (import.meta.main) {
  const hits = await collectHits();
  const md = renderReport(hits);
  await Deno.writeTextFile("dev-docs/engineering/test-silent-skips.md", md);
  const byReason = new Map<string, number>();
  for (const hit of hits) {
    byReason.set(hit.reason, (byReason.get(hit.reason) ?? 0) + 1);
  }
  const summary = [...byReason.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${reason}=${count}`)
    .join(" ");
  console.log(
    `静默跳过清单已写入 dev-docs/engineering/test-silent-skips.md（${hits.length} 处：${summary}）`,
  );
}
