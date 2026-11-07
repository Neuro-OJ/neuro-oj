# Agent Note: 新增 OI 赛制 A+B 样例题包（native / wasm）

Status: implemented

## Problem

仓库只有 `data/problems-src/1001` 一个 dual 评测的 Python 样例，缺少
`judge_type: "oi"` 的最小可导入题包，无法本地验证 OI 子任务评分、依赖与
两种评测后端（`native` / `wasm`）的完整链路。

## Decision

- 新增两个题包：`a-plus-b-oi-native`（题号 1101）与
  `a-plus-b-oi-wasm`（题号 1102），均为 `format_version: 2`、
  `judge_type: "oi"`、`scoring_version: 2`、`languages: ["c", "cc"]`、
  `checker: { "type": "default" }`。
- native 包 4 个测试点、两个子任务：`basic` 30 分（±10^3）、`large` 70 分
  （±10^18，`depends_on: ["basic"]`）。
- wasm 包 6 个测试点、三个子任务：`sign` 30、`small` 30、`large` 40
  （`depends_on: ["small"]`），覆盖 0、负数、32 位溢出边界与 64 位边界。
- 两包各带 `submission.cc` 参考实现（构建时按 `-x submission*` 排除）与
  `statement.md`，说明 64 位整数、默认 checker 的空白语义、子任务依赖与
  WASM 参考毫秒的非墙钟含义。

## Alternatives considered

- 复用 1001 的 dual 结构：OI 不使用 `evaluate.py`，无法覆盖 native/wasm
  子任务评分路径。
- 只建一个包并切换 backend：两个后端的资源池、编译链与时间语义不同，
  分开保留可以直接对照验收。

## Consequences

- `deno task problems:build` 会额外产出两个 zip；导入后可在同一域内直接
  提交 C/C++ 代码。
- 实测：native 参考解得 100 分（4/4 AC），错误解得 0 分；wasm 参考解得
  100 分（6/6 AC），32 位溢出解得 60 分且 `large` 因依赖未通过记 0。
- wasm 评测需要 judge 配置 `/opt/wasi-sdk` 与 `JUDGE_RESOURCE_POOLS`
  包含 `oi-wasm`；未配置时提交会停留在队列。
