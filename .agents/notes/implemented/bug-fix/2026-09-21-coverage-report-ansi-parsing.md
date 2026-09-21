# Agent Note: 覆盖率报告在 TTY 下静默丢失模块（ANSI 转义未剥离）

Status: implemented

## Problem

`scripts/coverage-report.ts` 的 `parseCoverageLine` 直接对原始行取 `trim()` 后
按 `|` 分列：

```ts
const trimmed = line.trim();
...
const numbers = rest.slice(0, 3).map((cell) => Number(cell.replace(/%$/, "")));
if (numbers.some((n) => Number.isNaN(n))) return null;
```

`deno coverage` 在 **TTY**（本地终端）下会给表格单元格着色，输出形如：

```
| \x1b[0m\x1b[32mutils/x.ts\x1b[0m | \x1b[0m\x1b[32m    100.0\x1b[0m | ...
```

`Number("\x1b[0m\x1b[32m    100.0\x1b[0m")` 为 `NaN`，整行被判为"无法解析"。
后果（实测）：

```
$ deno run -A scripts/coverage-report.ts --report --check
⚠ noj-ui 未解析到覆盖率数据（exit 0），请检查 test:coverage 任务输出
⚠ noj-llm-gateway 未解析到覆盖率数据（exit 0），请检查 test:coverage 任务输出
```

即使两个模块的 `test:coverage` 都 **exit 0 且覆盖率远超阈值**，报告仍缺失它们
的行——`--check` 的退出码由模块自身的 `deno coverage --threshold` 保证，所以
这是**纯报告内容的静默丢失**：本地看到的覆盖率报告与 CI 的（非 TTY，无颜色）
不一致，且缺失表现为"没有数据"，掩盖了真实的解析缺陷。

单测复现（修复前）：

```
coverage-report: 带 ANSI 转义码的行也能解析 ... FAILED
coverage-report: 带 ANSI 的完整表格仍能汇总 ... FAILED
```

## Decision

新增 `stripAnsi()` 并在 `parseCoverageLine` 起始处剥离 SGR 序列
（`\x1b\[[0-9;]*m`）：

```ts
const trimmed = stripAnsi(line).trim();
```

导出该函数以便单测直接断言。回归用例（`scripts/coverage-report_test.ts`）新增
3 条：带 ANSI 的单行解析、带 ANSI 的完整表格汇总、`stripAnsi` 自身。

## Alternatives considered

1. **在 `runCapture` 里把子进程的 TTY 关掉（设 `NO_COLOR=1`）**：拒绝。这会
   改动子进程环境，且 `deno coverage` 是否尊重 `NO_COLOR` 属其实现细节；在解析
   侧做防御更可靠，也能覆盖"输出被上游注入颜色"的情形。
2. **只放宽数字解析（从单元格里提取数字子串）**：拒绝。会把含任意文本的畸形
   单元格也解析成数字，削弱门禁的"无法解析即跳过该行"语义。剥离转义码是更
   精确的输入归一化。
3. **不修（CI 非 TTY 不受影响）**：拒绝。本地报告缺失模块、与 CI 不一致，正
   是本仓库反复出现的"本地假绿/口径漂移"一类缺陷。

## Consequences

- TTY 与非 TTY 下的报告内容一致，本地不再静默丢失模块行。
- 解析口径不变：仍然只接受 `|` 表格行、表头/分隔行返回 `null`。
- 未改动 `--check` 的退出码判定逻辑（阈值仍由各模块 `deno coverage` 负责）。
