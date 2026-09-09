# Agent Note: 测试增强路线图

Status: implemented

## Problem

测试体系存在四类问题：覆盖不足（UI 组件、gateway 错误分支、judge
边界、SSE/种子等几乎无测试）、可靠性差（E2E 静默跳过、重试散落、审计断言只查
200）、CI 反馈慢（无分片、Rust
编译无缓存）、缺少新测试类型（属性测试、模糊测试、性能基准、LLM 回放快照）。

同时评审发现两类更严重的问题：

- **「不能失败」的测试**：限流锁定用例在 E2E 栈默认关闭限流的情况下恒真、且被
  `extraIgnore` 跳过；`noj-judge/tests/e2e_abnormal.rs` 四个用例全是 `#[ignore]`
  且未登记进 CI 目标清单，只编译不执行；
- **工具本身无效**：覆盖率聚合脚本解析的是自造的 `covered/total`
  行（`deno coverage` 真实输出只有百分比列），报告恒为两个 0；静默跳过扫描只认
  `ignore: true` 与 `Deno.env.get`，看不见仓库里占绝对多数的
  `if (!isE2E) return;`。

## Decision

按「补覆盖 / 提可靠性 / 加速 CI /
新测试类型」四个方向实施，并修复评审发现的缺陷：

- **测试类型**：core 分页属性测试、judge ZIP 随机字节模糊测试（固定 LCG
  种子、有界迭代）、分页解析性能基准、gateway LLM 回放快照与限流快照、UI
  组件/composable 单测（Vitest，独立 `ui-components` job）。
- **可靠性**：新增 `retryE2E`（有限重试，仅用于幂等读操作）；E2E
  审计断言改为校验业务副作用（公告标题 + `admin_id` +
  时间戳）；新增异常场景用例（提交/重测、MQ 非法消息、竞赛防作弊
  SSE、存储故障、限流锁定、浏览器错误流程）。
- **限流锁定用例重做**：从 `identity` 域移到独立 `rate-limit` 域，配套
  `e2e-rate-limit` job 设置
  `RATE_LIMIT_ENABLED=true`、放宽窗口限流、关闭失败退避；断言改为「连续 10
  次错误密码后正确密码也被拒 + 响应提示锁定 + Redis 存在 `loginlock:<user>`」。
- **反作弊 SSE
  用例重做**：未报名用户断言收不到提交事件帧；报名用户断言能收到帧且帧内不含
  `user_id`。
- **MQ
  毒消息用例重做**：除队列接口可用外，断言随后提交的正常任务能评测完成、毒消息最终不在
  `processing`；`docker exec` 失败直接失败而非跳过。
- **judge E2E 登记**：`e2e_abnormal` / `e2e_solution_ai` 加入 `e2e.yml`
  judge-sandbox 的 `run_group` 目标清单。
- **覆盖率工具修复**：`coverage-report.ts` 解析 `deno coverage`
  真实表格（百分比口径），`--check` 恢复模块 `--threshold`
  门禁（退出码非零即失败），不再输出假的 `covered/total`；`noj-core` /
  `noj-judge` 不再伪造 0 行。
- **静默跳过扫描修复**：识别
  `ignore: !`、`if (!isE2E ...) return`、`console.log("...跳过")`、Rust
  `#[ignore]` / `if !is_e2e_enabled()`，扫描范围含 helper/setup 与 `.rs`；接入
  `check-ci.ts`，报告随 CI artifact 上传。
- **分片参数修复**：`--shards N`
  超过内置分片数时报错（不再静默截断），单测覆盖非法值与超限值。
- **Rust 编译缓存修复**：删除对 `${{ runner.temp }}/sccache` 的无效
  `actions/cache` 步骤；`mozilla/sccache-action` 只安装二进制，改为显式设置
  `RUSTC_WRAPPER=sccache` 与 `SCCACHE_GHA_ENABLED=true`（GHA cache backend）。
- **生产行为变更显式化**：`noj-llm-gateway/src/routes/llm.ts` 把同步
  `JSON.parse` 异常改为 `upstreamBody = null`，畸形上游 200 响应从 500 变为
  200 + `null` 并审计为 `ok`；新增测试固化该语义（原先的 `.catch`
  永远捕获不到同步抛错）。

## Alternatives considered

- **给限流用例加环境变量跳过**：仍然无法验证真实锁定，且 CI
  永远不跑；改为独立域 + 真实开启限流。
- **删除 `e2e_abnormal.rs`**：用例本身覆盖真实缺陷（evaluator
  崩溃、无结果、镜像缺失、支持包缺失），应当登记执行而非删除。
- **覆盖率报告继续输出占位
  0**：误导性高于缺失，改为「未采集」不出现该行，并让门禁真正生效。
- **静默跳过扫描只做报告不接线**：会再次变成死工具，故接入 `check-ci.ts` 并上传
  artifact。
- **用 `actions/cache` 缓存本地 sccache 目录**：sccache 使用 GHA cache
  backend，本地目录既非默认路径也不会被写入，属无效步骤。
- **把 `--shards` 扩到 8**：当前只有 unit/db 两个分片，扩分片需要重排 schema
  隔离策略，本次只做「不静默截断 + 报错」。

## Consequences

- 新增 5 类测试工具/类型与 6 个异常场景用例；`noj-core/tests/scripts`（含本 PR
  的 `test-parallel.test.ts`）已加入
  `test-shared.sh`，不再有「写了但从不执行」的测试。
- 覆盖率门禁重新生效（gateway 54% / ui 60%），低于阈值时 `coverage-check`
  失败；报告与静默跳过清单作为 CI artifact 保留 14 天。
- 静默跳过清单当前记录 511 处（early-return 268 / ignore 162 / rust-ignore 43 /
  rust-env-guard 25 / env-guard 13），为后续逐步收敛提供基线；本轮不设硬门禁。
- `rate-limit` 域需要完整 E2E 栈且服务端开启限流，CI 时间增加约 5 分钟。
- 畸形上游 LLM 响应不再 500，而是 200 + `null` 并审计为 `ok`；调用方需按「score
  为 null 即视为失败」处理（gateway 侧已按此语义返回）。
- `--shards` 超过内置分片数时命令直接报错，本地脚本行为更严格。
