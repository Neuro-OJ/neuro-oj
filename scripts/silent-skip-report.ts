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

/**
 * 基线文件（2026-09-12 架构评审 §5.1）。
 *
 * 背景：本脚本此前**只写报告、从不 exit 1**（CI 步骤名就叫"静默跳过扫描（报告）"），
 * 于是"跳过数增长"永远不会被发现；文档也漂移到 511 处（实际 515）。
 * 现在把跳过数纳入基线：**任何维度增长即失败**，下降才允许（并在更新基线后生效）。
 */
export const BASELINE_PATH =
  "dev-docs/engineering/test-silent-skips.baseline.json";
export const REPORT_PATH = "dev-docs/engineering/test-silent-skips.md";

export interface SkipBaseline {
  total: number;
  by_reason: Record<string, number>;
  by_file: Record<string, number>;
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
  const byReason = summarizeReasons(hits);
  const lines = [
    "# 静默跳过测试清单",
    "",
    "> 由 `deno run -A scripts/silent-skip-report.ts` 生成；",
    "> 命中 `ignore` / 环境变量守卫 / 测试体内提前 return / Rust `#[ignore]`。",
    ">",
    `> 当前命中 **${hits.length}** 处（${
      [...byReason.entries()].sort((a, b) => b[1] - a[1]).map(([r, c]) =>
        `${r}=${c}`
      ).join(" ")
    }）。`,
    "> 该数量受基线门禁约束：任何增长都会让 `scripts/silent-skip-report.ts --check` 失败",
    `> （基线文件 \`${BASELINE_PATH}\`）。`,
    "",
    "| 文件 | 行号 | 原因 |",
    "|---|---|---|",
  ];
  for (const h of hits) {
    lines.push(`| ${h.file} | ${h.line} | ${h.reason} |`);
  }
  return lines.join("\n") + "\n";
}

/** 按原因统计。 */
export function summarizeReasons(hits: SkipHit[]): Map<string, number> {
  const byReason = new Map<string, number>();
  for (const hit of hits) {
    byReason.set(hit.reason, (byReason.get(hit.reason) ?? 0) + 1);
  }
  return byReason;
}

/** 按文件统计。 */
export function summarizeFiles(hits: SkipHit[]): Map<string, number> {
  const byFile = new Map<string, number>();
  for (const hit of hits) {
    byFile.set(hit.file, (byFile.get(hit.file) ?? 0) + 1);
  }
  return byFile;
}

/** 由命中集生成基线对象。 */
export function buildBaseline(hits: SkipHit[]): SkipBaseline {
  return {
    total: hits.length,
    by_reason: Object.fromEntries(
      [...summarizeReasons(hits).entries()].sort((a, b) =>
        a[0].localeCompare(b[0])
      ),
    ),
    by_file: Object.fromEntries(
      [...summarizeFiles(hits).entries()].sort((a, b) =>
        a[0].localeCompare(b[0])
      ),
    ),
  };
}

/**
 * 与基线比对，返回失败原因列表（空数组 = 通过）。
 *
 * 规则：
 * - 总数增长 → 失败；总数下降 → 通过（提示更新基线）；
 * - 任一原因分类增长 → 失败；
 * - 任一文件增长（含新文件）→ 失败——只看总数会漏掉"某文件 +10、另一文件 -10"的抵消。
 *
 * 自检：基线 total > 0 而当前命中为 0 → 判定扫描器失效（而非"问题已清零"），
 * 避免扫描规则与代码写法脱节后门禁自动变绿。
 */
export function compareWithBaseline(
  hits: SkipHit[],
  baseline: SkipBaseline,
): string[] {
  const errors: string[] = [];
  if (baseline.total > 0 && hits.length === 0) {
    errors.push(
      `当前扫描到 0 处静默跳过，但基线为 ${baseline.total} 处——扫描规则很可能已失效（而不是问题清零）`,
    );
    return errors;
  }
  if (hits.length > baseline.total) {
    errors.push(
      `静默跳过数量增长：基线 ${baseline.total} → 当前 ${hits.length}（+${
        hits.length - baseline.total
      }）`,
    );
  }
  const reasons = summarizeReasons(hits);
  for (const [reason, count] of reasons) {
    const base = baseline.by_reason[reason] ?? 0;
    if (count > base) {
      errors.push(`原因 ${reason} 增长：基线 ${base} → 当前 ${count}`);
    }
  }
  const files = summarizeFiles(hits);
  for (const [file, count] of files) {
    const base = baseline.by_file[file] ?? 0;
    if (count > base) {
      errors.push(`${file} 静默跳过增长：基线 ${base} → 当前 ${count}`);
    }
  }
  return errors;
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
  const check = Deno.args.includes("--check");
  const writeBaseline = Deno.args.includes("--update-baseline");
  const hits = await collectHits();

  // 自检：必须真的扫到测试文件，否则"0 处跳过"是假绿灯
  const scannedFiles = (await Promise.all(
    ["noj-core", "noj-ui", "noj-llm-gateway", "noj-tests", "noj-judge"].map(
      (r) => collectFiles(r),
    ),
  )).reduce((acc, files) => acc + files.length, 0);
  if (scannedFiles === 0) {
    console.error(
      "静默跳过扫描失败：未扫描到任何测试文件（根目录或扫描规则已失效）",
    );
    Deno.exit(1);
  }

  const md = renderReport(hits);
  const baseline = buildBaseline(hits);
  await Deno.writeTextFile(REPORT_PATH, md);

  const byReason = summarizeReasons(hits);
  const summary = [...byReason.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${reason}=${count}`)
    .join(" ");
  console.log(
    `静默跳过清单已写入 ${REPORT_PATH}（扫描 ${scannedFiles} 个测试文件，命中 ${hits.length} 处：${summary}）`,
  );

  if (writeBaseline) {
    await Deno.writeTextFile(
      BASELINE_PATH,
      JSON.stringify(baseline, null, 2) + "\n",
    );
    console.log(`基线已更新：${BASELINE_PATH}（total=${baseline.total}）`);
    Deno.exit(0);
  }

  if (!check) {
    console.log(
      "提示：本次只生成报告。CI 使用 --check 与基线比对（跳过数增长即失败）。",
    );
    Deno.exit(0);
  }

  // ── --check：与基线比对 + 报告文件新鲜度 ──
  let base: SkipBaseline | null = null;
  try {
    base = JSON.parse(await Deno.readTextFile(BASELINE_PATH)) as SkipBaseline;
  } catch (err) {
    console.error(
      `静默跳过基线不可读：${BASELINE_PATH}（${err}）\n首次建立基线：deno run -A scripts/silent-skip-report.ts --update-baseline`,
    );
    Deno.exit(1);
  }

  const errors = compareWithBaseline(hits, base);
  const onDisk = await Deno.readTextFile(REPORT_PATH);
  if (onDisk !== md) {
    errors.push(
      `${REPORT_PATH} 与扫描结果不一致（报告过期），请运行 deno run -A scripts/silent-skip-report.ts`,
    );
  }

  if (errors.length > 0) {
    console.error("静默跳过门禁失败：");
    for (const e of errors) console.error(`- ${e}`);
    console.error(
      "\n若是重构导致位置变化（数量未增），请运行 --update-baseline 更新基线；" +
        "若确实新增了跳过，请改为真正执行测试或说明原因。",
    );
    Deno.exit(1);
  }
  console.log(
    `静默跳过门禁通过（${hits.length} 处，未超过基线 ${base.total} 处）`,
  );
}
