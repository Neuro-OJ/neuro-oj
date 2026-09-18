# Agent Note: 移除 jwt 测试的静默跳过守卫

Status: implemented

## Problem

`noj-core/src/domains/identity/tests/lib/jwt.test.ts` 的 7 个用例原先全部带
`ignore: !hasJwtSecret` 守卫（顶层 `const hasJwtSecret = !!Deno.env.get("JWT_SECRET")`）。
在 CI（工作流注入 `JWT_SECRET`）下这些用例会真正执行，但任何未注入密钥的环境
（本地直接跑、或仅以 PGlite 运行该文件）下整个文件会被静默跳过：报告显示 ok，实际零验证。

上游提交 `b8699802e`（凭据变更原子撤销全部旧会话）在文件顶部新增了
「会话版本往返且拒绝畸形版本」用例，使该文件的 ignore 数由 6 增至 7，全仓静默跳过
总数由基线 515 增至 516。仓库级门禁 `scripts/silent-skip-report.ts --check`
（2026-09-12 架构评审 §5.1 引入的基线棘轮）按「总数 / 原因 / 文件」三个维度判定
增长即失败，因此 `main` 最新提交的 Root Gates 持续红灯。

## Decision

把该文件的守卫从「可能整文件跳过」改为「无条件兜底注入仅测试用的固定密钥」：
文件加载时若无 `JWT_SECRET` 则 `Deno.env.set` 一个长度 ≥32 的固定测试值，
所有用例去掉 `ignore` 并始终真正执行。这与既有先例一致：
`noj-core/scripts/test-domain.sh`、`test-shared.sh` 提供 `JWT_SECRET:-` 兜底，
contest / community 域测试也各自注入固定测试密钥。CI 注入的真实密钥优先级更高。

## Alternatives considered

仅运行 `--update-baseline` 上调基线：基线棘轮只允许下调，用它放行新增跳过等于
把「假绿」制度化，且会让新增的会话版本用例在缺密钥环境下永不执行，违背门禁初衷。

改用 `ignore: Deno.env.get("JWT_SECRET") === undefined` 惰性求值：属性值注定命中
扫描规则 `ignore:\s*Deno\.env\.get`，会被记为 env-guard，跳过计数只增不减，
无法通过门禁。

重构为纯函数并注入密钥：用例本身已不依赖数据库，兜底注入是改动最小、语义最贴近
现有测试约定的做法，无需新增导出或辅助模块。

## Consequences

该文件 7 个用例在任何环境都会真正执行，假绿消除；CI 用工作流注入的真实密钥，
本地/单独运行用固定测试值。全仓静默跳过总数由 515 降到 509（ignore 由 162 降到
156，其余原因分类不变），生成物 `dev-docs/engineering/test-silent-skips.md`
随扫描器重新生成。基线 JSON 无需改动：门禁允许下降，下次需要收紧时再下调。
惰性求值守卫是后续新增测试的首选写法，避免再出现整文件跳过。
