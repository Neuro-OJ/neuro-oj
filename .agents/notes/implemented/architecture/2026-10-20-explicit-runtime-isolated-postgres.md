# Agent Note: 显式迁移与启动边界及隔离 PostgreSQL 测试底座

Status: implemented

## Problem

生产数据库连接同时承担测试后端、测试事务代理与 schema
分片，测试能够在依赖缺失时静默 跳过。HTTP 启动隐式执行迁移和系统种子，Gateway
应用工厂隐式创建连接和后台任务；这些 行为使启动、关闭和隔离验收的责任不清晰。

移除测试事务代理后，既有用例中的跨用例状态、未恢复的
DDL、依赖根连接方法拦截的故障 注入，以及只在内存数据库成立的结果形态假设均被真实
PostgreSQL 回归暴露。

## Decision

- 生产连接仅支持 PostgreSQL。测试辅助位于测试目录；reset、seed 和 bootstrap
  必须验证 本 run 的非空前缀、精确数据库名及连接的
  `current_database()`，不接受仅凭环境模式清库。
- Core 与 Gateway 的迁移及初始化由显式 one-shot 命令承担。HTTP
  启动只读检查发布资产 与数据库 ledger 的名称、数量、顺序、hash 和
  timestamp，失败时拒绝启动并提示显式迁移。 ledger 按源表数值 ID
  排序，避免文本别名造成 `1,10,100` 顺序错误。
- Core 正式迁移目录仅保留 journal 登记的 SQL。未登记的历史手工
  `0007_fk_cascade.sql` 原样移至
  `dev-docs/engineering/archives/legacy-sql/`，不执行这份 旧脚本、不补写
  journal、不改任何正式历史迁移。
- Gateway 的历史迁移使用固定文件名和 SHA-256 manifest，并要求文件完整。旧 ledger
  没有 hash/timestamp
  时，只有显式迁移能够采纳该固定基线；这不能证明旧执行过程使用过 相同字节。HTTP
  检查本身不回填或修复 ledger。
- 设置失效监听由组合根显式启动为受管任务，退订后等待在途
  reload。结果写回后的榜单刷新
  纳入处理函数等待；正式成绩提交后刷新失败仍按既有规则记录并回退内联查询。
- 测试启动器不读取开发 `.env`。Core 使用每 run
  模板库、正式迁移和种子、分片克隆库及 独立存储目录；同库文件不并发
  reset。必需依赖缺失直接失败，纯逻辑任务保持零外部依赖。
- 测试中的故障注入使用真实事务和 PostgreSQL 约束，恢复 DDL
  并独立建立所需夹具，不再 依赖拦截生产连接或包装 `Deno.test`。
- Compose、CLI 启动和恢复入口显式串联 Core migration/init、Gateway
  migration/seed 与 HTTP；one-shot 完成态作为业务服务启动的前置条件。

## Alternatives considered

- 保留 PGlite 和手写测试 DDL：无法证明真实 PostgreSQL
  的锁、约束、迁移与回滚行为。
- 在 HTTP 启动时继续自动迁移和种子：无法保持启动只读与维护窗口的明确提交点。
- 将未登记的历史 SQL 补入 journal
  或添加兼容白名单：会改变迁移历史或掩盖资产差集，
  且该脚本引用了后续已退役的表，因此保留原文归档。
- 让后台刷新继续脱离消费者生命周期：关闭时无法证明数据库依赖关闭前已完成在途操作。
- 为通过回归而放宽业务断言或跳过必需依赖：保留原业务预期，修复测试隔离与真实数据库
  故障注入。

## Consequences

集成测试需要显式提供专用
PostgreSQL/Redis，纯逻辑检查可独立执行。启动不再代替安装或
升级，运维必须先完成显式迁移和初始化；源代码和镜像必须携带同一套迁移资产。

P2b 已在 2026-10-21 完成集中验收。真实进程检查覆盖空库启动拒绝且不建表、
生产顺序的显式迁移初始化、两服务 ready、普通用户注册/登录/profile、正常关闭和
ledger 漂移拒绝且不自动修复；证据为 `/tmp/noj-p2b-live-o_xu543s/results.json`。

Core 正式 `deno task test:parallel` 通过：共享分片 457 passed / 0 failed / 6
ignored， 业务分片 2020 passed / 0 failed；证据为
`/tmp/noj-p2b-validation-_l_ovkzf/results.json`。这些是原始分片计数，包含各分片迁移与种子检查。
主代理核验该 run 的数据库、Redis
容器及存储目录均无残留。完整回归后最后的测试环境 清理硬化单独通过对应 pool queue
与 launcher 正式定向测试，没有重复宣称执行完整回归。

Gateway 正式回归为 162 passed / 0 failed / 1 ignored（可选真实上游 API），
父启动器在 finally 中清理独占数据库与本 run Redis namespace，真实并行 namespace
用例验证清理不影响另一个 run；CLI 正式生产测试 519 passed / 0 failed / 4
ignored。 Core/Gateway/CLI 静态检查通过；最终根门禁 217 passed / 0
failed，证据为
`/tmp/noj-p2b-final-root-20261021.log`。完整批次验证及可选门控的范围见批准计划跟踪清单。

本轮只使用任务专用隔离资源，没有执行生产切换。模块所有权、持久任务、配额权威、Judge
协议、前端读取和协调发布继续按 P3–P8 推进。
