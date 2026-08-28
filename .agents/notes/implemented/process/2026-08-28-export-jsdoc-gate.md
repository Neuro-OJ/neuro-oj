# Agent Note: 导出 JSDoc 覆盖率门禁

Status: implemented

## Problem

NOJ 的导出符号注释覆盖没有硬性约束，新代码可以随时加入无 JSDoc 的公开导出；noj-ui 导出 JSDoc 覆盖率偏低，且已有注释与实现不一致案例。

## Decision

新增 `scripts/verify-export-jsdoc.ts`，统计指定目录下 `.ts` 导出声明中带 `/** */` 的比例，低于阈值时退出非零。

- 当前阈值：`noj-core/src` ≥ 59.6%，`noj-llm-gateway/src` ≥ 69.4%。
- 脚本以仓库根目录解析目标路径，可从任意模块目录通过 `deno task check:jsdoc` 运行。
- CI 在 `core-quick-check` 与 `gateway-check` 中运行该检查，并将 `scripts/**` 纳入 core/gateway 路径过滤。

## Alternatives considered

- 要求 100% 导出必须带 JSDoc：现有代码达不到，直接启用会导致 CI 全红，需要先大规模补注释。
- 仅检查新增文件：需要 diff 感知，复杂度高且容易被绕过。
- 使用 Deno lint 规则：Deno 内置规则无法精确覆盖“导出声明前是否有 JSDoc”。

## Consequences

- 现有注释覆盖率不会倒退，新增无注释导出会逐步拉低覆盖率直至触发 CI。
- 阈值是当前基线，后续可在补足注释后逐步提高。
- CI 多一个静态检查步骤，但脚本运行成本低。
