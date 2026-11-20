# Agent Note: 删除空转与纯登记类治理门禁，精简 AGENTS.md

Status: implemented

## Problem

core 架构重构（`openspec/changes/refactor-core-feature-slices`）阶段 1
的目标是先砍流程开销。 逐项评估后发现一批门禁不防任何真实事故：`check-domains`
扫描的 `src/domains/` 早已不存在，每次扫描 0
个文件直接通过；`verify-export-jsdoc` 按目录整体比例计 JSDoc 覆盖率，
是纯风格要求；`verify-capability-seams` 只守两个 Provider
家族、从未拦住真实缺陷，
每次目录调整都要手工改路径表；`check-contract-reexports`
只要求为跨模块转出文件登记说明； 路由目录与事件目录的 `--check`
只防一份运行时无人读取的文档过期。 同时根 `AGENTS.md`（475 行）与
`noj-core/AGENTS.md`（815 行）大量重复、含历史沿革与已删门禁描述。

## Decision

- 删除上述 4
  个门禁脚本及其测试、`contract-reexport-registry.json`、`capability-seams.md`，
  并移除 `gate-list.ts` 与各 `deno.json` 中的接入点。
- 路由/事件目录改为按需本地生成，不再提交产物（加入
  `.gitignore`）；路由生成器的自检 改为在 `gen-route-catalog_test.ts`
  中内存生成后断言，防护不丢。
- 保留 `verify-domain-ci`：它防「只改共享文件时 CI
  静默跳过全部测试」，属于防事故。
- 跨模块转出文件暂不合并：实验表明在系统设置等底座能力迁入 `kernel/` 之前合并，
  会产生 access → platform → access 的运行时循环，已顺延到提案任务 2.6。
- 根 `AGENTS.md` 精简至约 250 行，写明集成分支为 `rc/v0.11`、新增架构方向小节；
  `noj-core/AGENTS.md` 精简至约 170 行，只保留模块特有约定。

## Alternatives considered

- 将门禁降级为非阻断而保留脚本：仍需维护脚本与登记表，收益不抵成本。
- 先合并转出文件再删门禁：受上述循环依赖阻塞，顺序不可行。

## Consequences

- `check:all` 少 6 项运行门禁与 4 项自测，约 3300
  行脚本、登记与文档被删除；全部门禁通过。
- 需要路由/事件目录时运行
  `deno run -A scripts/gen-route-catalog.ts`（事件同理）本地生成。
- 历史评审/基线文档中对已删文件的链接改为纯文本，结论未改。
