# Agent Note: P3 模块运行时结构诊断门禁

Status: implemented

## Problem

现有 `check-domains.ts`
只检查遗留域的深路径导入，不能证明目标模块的真实文件运行时依赖无环，也无法区分
type-only、混合导入、生产门面整体 `export *` 和 dynamic
import。模块、表所有权及测试映射也没有一份可供脚本读取的单一元数据。

## Decision

新增 `dev-docs/engineering/module-boundaries.json`，登记 P3 的 12
个目标模块、遗留域映射、schema 文件表所有权（含 system storage 例外）及正式
test/CI 映射。新增 `scripts/module-test-metadata.ts`
作为测试入口的共享解析点；Core launcher 和并行分片从同一元数据同时发现 legacy 与
`modules/**` 测试，`check-module-boundaries.ts` 还校验 manifest 中列出的
task/job 确实存在。`check-module-boundaries.ts` 使用仓库既有的 TypeScript
Compiler API `npm:typescript@5.9.2` 保留真实运行时边，分别统计类型边，解析 JSON
运行时资产，计算 runtime/type SCC，并诊断 facade `export *`、HTTP system actor
factory 导入、runtime→业务、业务→read-models 和跨模块 service
深路径导入。默认只读输出迁移期诊断，`--strict` 才返回非零；故意破坏夹具由
`check-module-boundaries_test.ts` 覆盖并列入 `gate-list.ts` 自测，但尚未把
strict 结果接入 `check-ci`。

路由目录与写端点限流检查也复用元数据登记的模块根，新增真实模块路由发现负例，
防止目录搬迁后扫描范围静默缩小。CI 的域选择器从同一 JSON 读取别名，覆盖
education 环境标志的回归；新模块由 `core-test-sharded` 的正式完整
`deno task test:parallel` 覆盖，不能用只跑共享分片或静态 quick-check
代替业务测试。模块的 CI 映射明确指向该任务。

新增 Core `deno task test:gates`，复用完整 `GATE_SELF_TESTS`
清单；用于在迁移期其他门禁 仍失败时独立执行真实负例，不表示完整根门禁通过。

跨模块写服务检查明确是路径级边界诊断，不能代替调用语义或行为测试；业务用例迁移后仍须补真实调用图和事务负例。

## Alternatives considered

- 继续扩展 `check-domains.ts`：无法同时表达新模块、表所有权、SCC
  和类型/运行时边，且会把迁移期诊断与既有域门禁耦合。
- 使用大白名单忽略当前遗留环：会掩盖实际结构问题，因此保留完整诊断并只延迟
  strict 接入。
- 用 `import type` 关键词做文本过滤：会漏掉混合导入、模板表达式中的 dynamic
  import，并误判名为 `type` 的运行时绑定、尾逗号和正则文本；因此使用 TypeScript
  Compiler API 与真实相对路径解析。

## Consequences

迁移前基线在本次检查时为 544 个生产源码/JSON 文件、2821 条运行时边、472
条类型边、4 个 runtime SCC、109 张 schema 表；目标 `modules/` 仍缺 8
个目录。该基线用于逐批收敛，不表示 P3 已完成。`--strict`
的接入必须等模块迁移和现存负例清理后由主代理决定。

主代理通过正式 `deno task test:gates` 验证 231 passed / 0 failed，包含
AST、路由迁移 及实际 Python CI 选择器回归；日志为
`/tmp/noj-p3-gate-tests-20261021.log`。 CI 元数据校验通过，workflow YAML
可解析；完整 P3 回归和 strict 结构验收仍未完成。
