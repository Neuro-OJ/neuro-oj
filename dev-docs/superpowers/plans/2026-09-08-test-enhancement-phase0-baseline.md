# Phase 0 测试基线 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立统一覆盖率报告、静默跳过清单与慢测试基线，为后续测试增强阶段提供可衡量数据。

**Architecture:** 扩展现有 `scripts/coverage-report.ts` 为聚合报告入口；新增 `scripts/silent-skip-report.ts` 扫描测试跳过；新增 `scripts/test-baseline.ts` 记录各模块测试耗时；将 CI 的 coverage-check 从硬门禁改为报告模式。

**Tech Stack:** Deno 2、GitHub Actions、Bash。

**Spec:** `dev-docs/superpowers/specs/2026-09-08-test-enhancement-roadmap-design.md`

## Global Constraints

- 遵守 AGENTS.md：提交必须 GPG 签名；提交信息用 Conventional Commits 中文描述；禁止修改 `deno.lock` / `Cargo.lock` 手动内容。
- Deno 测试必须通过 `deno task` 封装命令运行，禁止手拼 `deno test` 绕过脚本。
- 中文注释、英文标识符。
- 不新增 CI 覆盖率硬门禁；现有 coverage-check 改为报告模式。

---

### Task 1: 扩展 coverage-report.ts 为聚合报告入口

**Files:**
- Modify: `scripts/coverage-report.ts`
- Create: `scripts/coverage-report_test.ts`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: 现有 `scripts/gate-runner.ts` 的 `run()`；各模块 `deno task test:coverage` / `cargo llvm-cov`。
- Produces: `scripts/coverage-report.ts --report` 输出 Markdown 报告到 `dev-docs/engineering/test-coverage.md`；`--check` 保持兼容但不再因阈值失败。

- [ ] **Step 1: 写失败测试**

创建 `scripts/coverage-report_test.ts`：

```ts
/**
 * coverage-report 聚合逻辑单元测试。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { parseCoverageSummary, renderMarkdown } from "./coverage-report.ts";

Deno.test("coverage-report: parseCoverageSummary 解析 Deno coverage 行", () => {
  const line = "  noj-ui  |  60.00%  |  120/200";
  const summary = parseCoverageSummary(line);
  assertEquals(summary.module, "noj-ui");
  assertEquals(summary.percent, 60);
  assertEquals(summary.covered, 120);
  assertEquals(summary.total, 200);
});

Deno.test("coverage-report: renderMarkdown 生成表格", () => {
  const md = renderMarkdown([
    { module: "noj-core", percent: 75, covered: 300, total: 400 },
    { module: "noj-ui", percent: 60, covered: 120, total: 200 },
  ]);
  assertEquals(md.includes("| noj-core | 75% | 300/400 |"), true);
  assertEquals(md.includes("| noj-ui | 60% | 120/200 |"), true);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `deno test -A scripts/coverage-report_test.ts`
Expected: FAIL，`parseCoverageSummary` / `renderMarkdown` 未定义。

- [ ] **Step 3: 实现聚合报告逻辑**

修改 `scripts/coverage-report.ts`，导出可测试函数并支持 `--report`：

```ts
// 覆盖率门禁/报告入口。
// --report：聚合各模块覆盖率并写入 dev-docs/engineering/test-coverage.md（不失败）。
// --check：保留旧行为，但只输出报告，不因阈值退出非零（与“不设硬门禁”一致）。
import { run } from "./gate-runner.ts";

export interface CoverageSummary {
  module: string;
  percent: number;
  covered: number;
  total: number;
}

export function parseCoverageSummary(line: string): CoverageSummary {
  const m = line.match(/^\s*([\w-]+)\s+\|\s+([\d.]+)%\s+\|\s+(\d+)\/(\d+)/);
  if (!m) throw new Error(`无法解析覆盖率行: ${line}`);
  return {
    module: m[1],
    percent: Number(m[2]),
    covered: Number(m[3]),
    total: Number(m[4]),
  };
}

export function renderMarkdown(rows: CoverageSummary[]): string {
  const lines = [
    "# 测试覆盖率报告",
    "",
    "| 模块 | 覆盖率 | 覆盖/总数 |",
    "|---|---|---|",
  ];
  for (const r of rows) {
    lines.push(`| ${r.module} | ${r.percent}% | ${r.covered}/${r.total} |`);
  }
  return lines.join("\n") + "\n";
}

async function collectSummaries(): Promise<CoverageSummary[]> {
  const out: CoverageSummary[] = [];
  // noj-ui / noj-llm-gateway 使用 deno coverage 输出
  for (const [module, dir] of [
    ["noj-ui", "noj-ui"],
    ["noj-llm-gateway", "noj-llm-gateway"],
  ] as const) {
    const result = await run(["deno", "task", "test:coverage"], dir);
    for (const line of result.stdout.split("\n")) {
      if (line.includes("%") && line.includes("/")) {
        try {
          out.push(parseCoverageSummary(line));
        } catch {
          // 忽略非汇总行
        }
      }
    }
  }
  // noj-core / noj-judge 暂以占位行输出（后续 Phase 1/3 接入真实数据）
  out.push({ module: "noj-core", percent: 0, covered: 0, total: 0 });
  out.push({ module: "noj-judge", percent: 0, covered: 0, total: 0 });
  return out;
}

if (import.meta.main) {
  const report = await collectSummaries();
  const md = renderMarkdown(report);
  if (Deno.args.includes("--report")) {
    await Deno.writeTextFile("dev-docs/engineering/test-coverage.md", md);
    console.log("覆盖率报告已写入 dev-docs/engineering/test-coverage.md");
  } else {
    console.log(md);
  }
}
```

> 注：`run()` 返回对象需含 `stdout`。若 `gate-runner.ts` 的 `run()` 只返回退出码，先阅读 `scripts/gate-runner.ts` 并按实际返回结构调整；本任务以“能拿到 stdout”为验收。

- [ ] **Step 4: 运行测试确认通过**

Run: `deno test -A scripts/coverage-report_test.ts`
Expected: PASS。

- [ ] **Step 5: 将 CI coverage-check 改为报告模式**

修改 `.github/workflows/ci.yml` 中 coverage-check job 的步骤：

```yaml
      - name: 覆盖率报告（不设硬门禁）
        run: deno run -A scripts/coverage-report.ts --report
```

- [ ] **Step 6: 提交**

```bash
jj describe -m "test(root): 覆盖率报告聚合与 CI 报告模式"
```

---

### Task 2: 新增静默跳过扫描脚本

**Files:**
- Create: `scripts/silent-skip-report.ts`
- Create: `scripts/silent-skip-report_test.ts`

**Interfaces:**
- Consumes: 仓库测试文件路径。
- Produces: `scripts/silent-skip-report.ts` 输出 Markdown 报告到 `dev-docs/engineering/test-silent-skips.md`。

- [ ] **Step 1: 写失败测试**

创建 `scripts/silent-skip-report_test.ts`：

```ts
/**
 * 静默跳过扫描逻辑单元测试。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { scanFile, renderReport } from "./silent-skip-report.ts";

Deno.test("silent-skip: scanFile 识别 ignore/skip 与环境变量守卫", () => {
  const source = `
Deno.test({ name: "a", ignore: true, fn: () => {} });
Deno.test("b", { ignore: Deno.env.get("DATABASE_URL") ? false : true }, () => {});
if (!Deno.env.get("JWT_SECRET")) return;
`;
  const hits = scanFile("tests/demo_test.ts", source);
  assertEquals(hits.some((h) => h.reason === "ignore"), true);
  assertEquals(hits.some((h) => h.reason === "env-guard"), true);
});

Deno.test("silent-skip: renderReport 生成 Markdown", () => {
  const md = renderReport([
    { file: "tests/a_test.ts", line: 3, reason: "ignore" },
  ]);
  assertEquals(md.includes("tests/a_test.ts"), true);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `deno test -A scripts/silent-skip-report_test.ts`
Expected: FAIL，函数未定义。

- [ ] **Step 3: 实现扫描脚本**

创建 `scripts/silent-skip-report.ts`：

```ts
/**
 * 静默跳过扫描：找出测试中因 ignore/skip/环境变量守卫而未真正执行的用例。
 */
import { walk } from "jsr:@std/fs@^1";

export interface SkipHit {
  file: string;
  line: number;
  reason: "ignore" | "skip" | "env-guard";
}

export function scanFile(file: string, source: string): SkipHit[] {
  const hits: SkipHit[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/\bignore\s*:\s*true\b/.test(line)) {
      hits.push({ file, line: i + 1, reason: "ignore" });
    }
    if (/\bignore\s*:\s*Deno\.env\.get/.test(line)) {
      hits.push({ file, line: i + 1, reason: "env-guard" });
    }
    if (/\bif\s*\(!?Deno\.env\.get\(/.test(line)) {
      hits.push({ file, line: i + 1, reason: "env-guard" });
    }
  }
  return hits;
}

export function renderReport(hits: SkipHit[]): string {
  const lines = ["# 静默跳过测试清单", "", "| 文件 | 行号 | 原因 |", "|---|---|---|"];
  for (const h of hits) {
    lines.push(`| ${h.file} | ${h.line} | ${h.reason} |`);
  }
  return lines.join("\n") + "\n";
}

async function collectHits(): Promise<SkipHit[]> {
  const hits: SkipHit[] = [];
  const roots = ["noj-core", "noj-ui", "noj-llm-gateway", "noj-tests"];
  for (const root of roots) {
    for await (const entry of walk(root, { exts: [".ts"], skip: [/node_modules/, /\.nuxt/, /\.output/, /coverage/] })) {
      if (!entry.isFile) continue;
      if (!/_test\.ts$|\.test\.ts$/.test(entry.path)) continue;
      const source = await Deno.readTextFile(entry.path);
      hits.push(...scanFile(entry.path, source));
    }
  }
  return hits;
}

if (import.meta.main) {
  const hits = await collectHits();
  const md = renderReport(hits);
  await Deno.writeTextFile("dev-docs/engineering/test-silent-skips.md", md);
  console.log(`静默跳过清单已写入 dev-docs/engineering/test-silent-skips.md（${hits.length} 处）`);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `deno test -A scripts/silent-skip-report_test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
jj describe -m "test(root): 新增静默跳过扫描报告"
```

---

### Task 3: 新增慢测试基线记录脚本

**Files:**
- Create: `scripts/test-baseline.ts`
- Create: `scripts/test-baseline_test.ts`
- Create: `dev-docs/engineering/test-baseline.md`

**Interfaces:**
- Consumes: 各模块测试命令。
- Produces: `scripts/test-baseline.ts` 将各模块测试耗时写入 `dev-docs/engineering/test-baseline.md`。

- [ ] **Step 1: 写失败测试**

创建 `scripts/test-baseline_test.ts`：

```ts
/**
 * 慢测试基线记录逻辑单元测试。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { formatDuration, renderBaseline } from "./test-baseline.ts";

Deno.test("test-baseline: formatDuration 格式化毫秒", () => {
  assertEquals(formatDuration(90_000), "1m30s");
  assertEquals(formatDuration(5_000), "5s");
});

Deno.test("test-baseline: renderBaseline 生成 Markdown", () => {
  const md = renderBaseline([
    { module: "noj-core", command: "deno task test:smoke", durationMs: 5_000 },
  ]);
  assertEquals(md.includes("| noj-core | deno task test:smoke | 5s |"), true);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `deno test -A scripts/test-baseline_test.ts`
Expected: FAIL，函数未定义。

- [ ] **Step 3: 实现脚本**

创建 `scripts/test-baseline.ts`：

```ts
/**
 * 慢测试基线：记录各模块代表性测试命令耗时，供 Phase 5 加速对比。
 */
import { run } from "./gate-runner.ts";

export interface BaselineRow {
  module: string;
  command: string;
  durationMs: number;
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s >= 60) return `${Math.floor(s / 60)}m${s % 60}s`;
  return `${s}s`;
}

export function renderBaseline(rows: BaselineRow[]): string {
  const lines = ["# 测试耗时基线", "", "| 模块 | 命令 | 耗时 |", "|---|---|---|"];
  for (const r of rows) {
    lines.push(`| ${r.module} | ${r.command} | ${formatDuration(r.durationMs)} |`);
  }
  return lines.join("\n") + "\n";
}

async function measure(command: string[], cwd: string): Promise<number> {
  const start = performance.now();
  await run(command, cwd);
  return performance.now() - start;
}

if (import.meta.main) {
  const rows: BaselineRow[] = [];
  rows.push({
    module: "noj-core",
    command: "deno task test:smoke",
    durationMs: await measure(["deno", "task", "test:smoke"], "noj-core"),
  });
  rows.push({
    module: "noj-ui",
    command: "deno task test",
    durationMs: await measure(["deno", "task", "test"], "noj-ui"),
  });
  rows.push({
    module: "noj-llm-gateway",
    command: "deno task test",
    durationMs: await measure(["deno", "task", "test"], "noj-llm-gateway"),
  });
  rows.push({
    module: "noj-judge",
    command: "cargo nextest run --all-targets",
    durationMs: await measure(["cargo", "nextest", "run", "--all-targets"], "noj-judge"),
  });
  const md = renderBaseline(rows);
  await Deno.writeTextFile("dev-docs/engineering/test-baseline.md", md);
  console.log("测试耗时基线已写入 dev-docs/engineering/test-baseline.md");
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `deno test -A scripts/test-baseline_test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
jj describe -m "test(root): 新增慢测试基线记录"
```

---

### Task 4: 更新 testing.md 使用说明

**Files:**
- Modify: `dev-docs/engineering/testing.md`

**Interfaces:**
- Consumes: Task 1-3 产出的脚本。
- Produces: 文档说明。

- [ ] **Step 1: 在 testing.md 的“后续计划”前增加“覆盖率报告与基线”小节**

在 `dev-docs/engineering/testing.md` 中追加：

```markdown
## 覆盖率报告与基线

- 覆盖率报告：`deno run -A scripts/coverage-report.ts --report`，输出到 `dev-docs/engineering/test-coverage.md`。
- 静默跳过清单：`deno run -A scripts/silent-skip-report.ts`，输出到 `dev-docs/engineering/test-silent-skips.md`。
- 慢测试基线：`deno run -A scripts/test-baseline.ts`，输出到 `dev-docs/engineering/test-baseline.md`。
- 覆盖率目标仅作趋势跟踪，不设 CI 硬门禁。
```

- [ ] **Step 2: 提交**

```bash
jj describe -m "docs(test): 补充覆盖率报告与基线使用说明"
```
