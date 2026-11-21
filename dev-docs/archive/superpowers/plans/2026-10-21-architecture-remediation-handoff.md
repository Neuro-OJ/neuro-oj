# NOJ 架构整治 P3–P8 交接说明（2026-10-21）

> 状态说明（2026-10-23）：本文记录的是中断时的交接现场；P3–P8 后续实施已经在同一
> 工作区完成。请以主计划末尾的「P3–P8 最终验收收口」和最终 Agent Note 为当前状态，
> 本文原有的“待继续/未开始”段落保留作为历史交接记录。

> 本文交给下一个执行代理继续推进。批准方案与验收标准仍是
> [2026-10-20-architecture-remediation.md](./2026-10-20-architecture-remediation.md)；
> 该文件末尾的「P3/P4/P5 续作进展」与本交接说明互补：前者记录已观察证据，
> 本文记录**接手位置、下一步具体动作、环境与红线**。
> 未满足放行条件的批次一律不勾选完成，缺口必须显式保留。

## 0. 一句话状态

P0/P1/P2a/P2b 已完成并冻结；P3 的模块迁移、HTTP/runtime 装配、旧实现删除与严格
结构门禁已完成，待本轮 Core 完整行为回归后最终勾选；P4 已完成通用任务切换、真实
故障/排空测试、指标与 runbook；P5 已完成本地政策权威、P5.3 advisory 并发屏障、
流式/ready/drain 验收。P6/P7/P8 仍待继续；生产环境未做任何操作。

## 1. 工作区与版本（先核对再动手）

| 项目 | 值 |
|---|---|
| 实施工作区 | `/home/xyber-nova/.codex/worktrees/noj-architecture-p3` |
| jj workspace | `architecture-p3` |
| jj bookmark | `wip/architecture-remediation-p3`（**接手时先 `jj bookmark set wip/architecture-remediation-p3 -r @` 前先确认它是否已指向最新 tip**） |
| 原始工作区（不要在此继续 P3） | `/home/xyber-nova/Github/neuro-oj` |
| 已验收 P2b 检查点 | `e6f391b5`（bookmark `architecture/p2b-runtime-postgres`） |
| P0 冻结混合祖先链 | 见 `dev-docs/engineering/architecture-baseline-2026-10-20.md`，**不得重写** |

全部提交均 GPG 签名。历史链（新→旧，`S` = signed）：

| change | commit | 内容 |
|---|---|---|
| `sqlvwnsv` | 本文档 | 交接说明 |
| `prluropn` | — | 记录 P5.2 进展与网关验证 |
| `wloqosxo` | — | P5.2：预占边界内读取本地政策 + 网关回归收敛 |
| `kpmrszwr` | — | 记录 P3/P4/P5 续作进展与决策 |
| `qmlzsqks` | — | 政策快照导出/导入 + Core 旧端点降级 |
| `qrlolyxs` | — | P5.1：Gateway 实例政策本地持久权威 |
| `ztzypzxk` | — | P4.5：教学 outbox 幂等迁移合同 |
| `ukqnxnxk` | — | P4.4：后台任务管理路由 + 审计动作 |
| `yzxvrlly` | — | P4.3：评测派发任务同事务登记 + 恢复 handler |
| `okrvorot` | — | P4.2：搜索索引事务内登记 + 应用 handler |
| `xpysvkok` | — | P4.1：`background_tasks` 表（迁移 0120）+ 任务原语 |
| `qvooxnyl` | — | P3.4：`revalidateEvaluationAdmissionTx` + 类型负例 |
| `qzwlsuln` | — | P3：竞赛别名报名语义 + 存储容量应用用例 |
| `kuvrztqo` | — | P3：教学事实登记改经 education 合同 |
| `tmrqwkmn` | — | P3：评测策略经 owner 合同写入 + SSE 事实入口 |
| `nrrymxnw` | — | P3：题目删除分三段 + 各 owner 事务写合同 |
| `muqprktz` | — | P3：发布显式 Actor + 事务内搜索索引 |
| `umkvrqmt` | — | P3：审计写入收口 + 系统身份装配 |
| `vqrwploy` | — | 修复邀请注册开户授权检查 |
| `wlusvxwn` | — | P3 阶段一：身份与事务合同收紧、业务所有权迁移 |
| `xmvtvlzt` | `e6f391b5` | P2b：显式装配运行时 + 隔离真实数据库测试（验收冻结） |

签名自检命令：

```bash
cd /home/xyber-nova/.codex/worktrees/noj-architecture-p3
jj log -r '@' --limit 1 --no-graph \
  -T 'change_id.short() ++ " " ++ commit_id.short() ++ " " ++ \
      if(signature, "SIGNED", "UNSIGNED") ++ "\n"'
```

## 2. 上手步骤（建议顺序）

1. `cd /home/xyber-nova/.codex/worktrees/noj-architecture-p3 && jj --no-pager status`
   （若 jj 卡住超过 1 分钟，检查是否有 `visualjj` 分支服务持有 `.jj` 锁：
   `ps aux | rg visualjj`，确认后可结束该进程，不要结束其他 jj 进程）。
2. 确认测试资源容器仍在运行（见 §7.1）；若已被清理，按 §7.2 重建新的隔离资源，
   不要把开发/生产资源写进测试。
3. 跑一次当前 tip 的基线验证（§7.3），确认与本文记录一致再开始改代码。
4. 按 §4 的顺序推进；每个逻辑单元一个 `jj change`、GPG 签名、中文提交信息；
   完成后 `jj bookmark set wip/architecture-remediation-p3 -r @`。

## 3. 已完成内容与证据（摘要，详细见计划文件）

- **P0/P1/P2a/P2b**：已完成并验收。P2b 证据：Core 完整并行测试 shared 457 passed /
  业务 2020 passed；Gateway 162 passed / 1 ignored；CLI 519 passed；根门禁 217 passed；
  真实进程空库拒绝启动、显式迁移后 ready、SIGTERM 正常退出。证据文件见交接文档
  §1.4（`/tmp/noj-p2b-validation-*` 为当时本地制品，不提交仓库）。
- **P3（部分）**：
  - 已建立 `Actor`（guest/user/system）、`DbRoot`/`DbTx`、模块边界 AST 检查、
    12 个目标模块与 110 张表 owner 元数据；
  - owner 事务写合同：evaluations 题目删除、assets 对象摘要、read-models revision、
    problems/contests 策略写入、education 事件、runtime SSE 事实、access 资源计数；
  - application 编排：`deleteProblemCommand`、`reserveUploadCommand` 系列、
    `revalidateEvaluationAdmissionTx`；
  - 迁移：Core `0120_youthful_pestilence.sql`（background_tasks）、
    `0121_brainy_jocasta.sql`（审计动作）；
  - 结构扫描（`deno run -A scripts/check-module-boundaries.ts`）：679 生产文件 /
    110 表 / owner 缺口 0 / type SCC 0；**runtime SCC 仍 3**、缺
    `modules/communication`、`modules/http` 两个目标根、facade `export *` 136、
    跨模块服务导入 7、runtime→业务 12、业务→读模型 5。
- **P4（已完成）**：`background_tasks` 表与 runtime 原语；搜索/评测派发同事务登记；
  教学 outbox 稳定游标迁移、通用 handler 的分页重新调度；生产不再启动旧教学进度
  worker，邮件与预约发布独立运行；任务/投影 Prometheus gauge、告警和
  `deploy/monitoring/runbooks/background-tasks.md`；真实 PG 子进程崩溃恢复与 worker drain。
- **P4 验证**：`runtime` 23 passed、`application` 13 passed、`education` 143 passed / 1
  ignored；Core `deno task check` 与相关门禁通过。
- **P5（已完成）**：Gateway `llm_policy` / `llm_policy_operations` 本地政策权威、
  `PUT/GET /internal/policy`、操作幂等查询、Core 快照导出/导入、旧端点降级；
  P5.2 预占边界内本地政策读取；P5.3 advisory 锁屏障、流式 unknown、ready 故障和
  drain 验收。
- **P5 最新验证**：`cd noj-llm-gateway && deno task check` 通过；在显式隔离 PG/Redis
  启动器中 `deno task test` **182 passed / 0 failed / 1 ignored**；日志
  `/tmp/noj-p5-final-gw-run-continued.log`（本地制品，不提交）。

## 4. 历史缺口与后续工作（按推荐顺序）

### 4.1 P5.3：Gateway 记账与关闭验收（已完成）

1. 已新增并通过 `noj-llm-gateway/tests/quota_policy_concurrency_test.ts`（真实 PG + Redis）：
   - 降额提交后开始的新预占必须使用新政策：先用旧政策预占成功，再
     `applyPolicyOperationTx` 写入更严政策，下一次带 callId 的 `enforceAndCount`
     必须 `limit_exceeded`，且 ledger 行 state = `denied`；
   - 在途预占按冻结账本结算：降额后 `settleCall` 已预占的调用仍成功；
   - 顺序屏障：用 `withReservationLock` 持共享政策读、另开连接执行
     `applyPolicyOperationTx`，用 `pg_locks`（advisory key 见下）确认写入等待，
     释放后写入生效；
   - 已完成：`readPolicyForReservation` 仍使用政策行锁读取，但
     `accounting.ts::withReservationLock` 已持有共享 advisory 锁，
     `policy-operations.ts::withLockedPolicy` 已持有同键事务级排他 advisory 锁，
     统一键为 `pg_advisory_*_lock(184789, 4)`；真实屏障测试通过并检查了
     `pg_locks`。
2. 流式连接中断结算：`stream_accounting_test.ts` 覆盖正常流、客户端断开、上游中断、
   已发上游但结果未知 → `unknown` 且不自动重发上游。
3. `ready` 故障测试：DB、Redis、记账 worker 分别不可用时 ready 必须失败；
   持久政策不可读时不能放行。
4. `drain`：停止后不得有未等待的记账写入（与 P2 `ManagedTask` 集成）。
5. Core 侧 Gateway client：有界超时 + 超时后按 operation ID 查询持久结果，
   **不要**换新 ID 重试；不得在持有 Core 数据库事务锁时调用 Gateway HTTP。
6. `policy_import_test.ts` 已新增并通过：覆盖存量值/revision 保留，以及重复导入
   不覆盖更新后的政策。
7. 模型别名/默认 Provider/模型选择的权威迁到 Gateway（Core 只保留 attempt 冻结值）。

### 4.2 P3 收尾（结构完成，待最终完整回归勾选）

P3.4–P3.7 已完成：评测 admission 合同已接入提交/产物提交/自测路径，教育、通信、
读模型、HTTP 与 runtime 已迁入目标模块，旧 evaluation 实现与迁移期门面已删除，
严格结构门禁已通过。当前只剩 `cd noj-core && deno task test` 的最终统一行为回归，
以及将最终计数写回计划后勾选 P3。

下列条目保留为实施历史和验收关注点，不代表仍未接线：

1. **P3.4 接线**：把 `revalidateEvaluationAdmissionTx`
   （`modules/evaluations/contracts/admission.ts`）接入
   `createDomainSubmission` / `createDomainArtifactSubmission` / `createDomainSelfTest`，
   删除这些函数内部对 contests/education 服务的上下文查找，改为消费 application
   组合好的计划；拆分客观题合同（problems 题面/答案 payload 校验 vs evaluations
   作答/判分/attempt/重判 DTO），修正 application 从 problems 旧类型入口导入执行 DTO 的调用；
   `applyAttemptResultCommand` / `saveEvaluationResultCommand` 保证终态+正式判定+
   有效成绩同事务、幂等、旧 attempt/错版本/错 sequence 不覆盖、平台错误保留成绩。
2. **P3.5 模块迁移**（文件量来自当前扫描）：
   - `domains/education/**`（102 文件 / 18231 行）→ `modules/education/**`；
   - `shared/education-events.ts`、`education-contests.ts`、`education-modules.ts`
     → education 合同（禁止 shared 持有业务写入）；
   - `domains/community/**`（40/11039）、`messaging`（9/4381）、`content-review`
     （14/1921）→ `modules/communication/{community,messaging,review}/`；
   - `domains/query/**`（18/3693）、`domains/search/**`（17/3519）→
     `modules/read-models/{queries,search}/`，读写与 worker 入口分开；
   - 明确拆分函数：`publishAssignmentTx`、`scheduleAssignmentTx`、
     `changeAssignmentLifecycleTx`、`retireDomainEducationMembershipsTx`、
     `joinInvitedClassroomTx`、`resolveAssignmentSubmissionOrigin`、
     `recomputeAssignmentProgress`。
3. **P3.6 HTTP/runtime 装配**：新增 `modules/http/create-app.ts`、
   `modules/http/routes/<module>/**`（含 admin 23 个路由文件）、
   `modules/application/create-system.ts`、`bootstrap.ts`、
   `modules/runtime/task-group.ts`、`modules/runtime/storage/**`、`runtime/email/**`、
   `runtime/system-actors.ts`；`main.ts` 只留配置/装配/生命周期；
   `assets/storage/factory.ts` 不再导入 platform settings 服务（application 读设置快照后
   交给 runtime factory）。
4. **P3.7 删除旧实现 + 严格门禁**：删除 `domains/{submission,objective,identity,
   workspace,catalog,contest,system,legal,query,search}` 重复实现；清 136 个
   `facade-export-star`；`check-module-boundaries.ts --strict` 接入
   `REPO_GATES`/`check-ci`；增加「业务导入另一业务写 capability」AST 负例；
   `legacyTestTargets` 映射（objective→problems+evaluations；workspace→access+problems+
   assets+application/education；system→platform+assets+application/runtime）；
   CI 必须真实运行分片测试。
5. **P3.8 必补测试**：`tests/types/access-contracts.ts`；
   `application account-lifecycle.pg.test.ts`、`problem-lifecycle.pg.test.ts`；
   `evaluations admission-revocation.pg.test.ts`、结果幂等/过时/错版本/错 sequence/
   平台错误；contests 409/保密；assets 容量竞争（已有
   `modules/assets/tests/services/storage-concurrency.pg.test.ts`）；platform 设置
   reload；read-models 权限矩阵；门禁负例。

### 4.3 P4 收尾（已完成）

- 教学 worker 已从旧 outbox 切到 `background_tasks`：先按稳定游标迁移状态
  （`migrateEducationOutboxTx`），再切生产者，生产组合根不再启动旧教学进度 worker；
- 任务积压/最老年龄/重试失败/租约/投影延迟指标与 runbook 已完成；
- 保留 `submission_jobs` 等业务进度表，不并入通用任务表；
- 真实子进程故障测试（提交后、完成标记前退出）与 worker drain 测试已通过。

### 4.4 P6 / P7 / P8（未开始，按批准方案第六～八章执行）

- **P6**：评测协议 v3（`evaluation_protocol_version=3`、task_kind、run identity =
  attempt_id / self_test_run_id、权威 sequence、可信封套校验；删除 `st_` 前缀推断与
  缺字段补齐）；Rust `WorkerContext`/`RunContext`、取消/租约丢失清理、fallback 原子落盘
  + ACK 条件、多 Worker 真实 Docker 测试。
- **P7**：Core 批量摘要 `POST /api/v1/domains/:slug/problem-summaries`（1–50 项、
  集合授权、固定 SQL 数量）、BFF 去逐题详情请求、页面 DTO/加载器、删除首屏快照桥接、
  session generation 与 `useResourceRefresh`、IDE 显式域 API；浏览器矩阵
  1440/768/390px 与 SSR/水合记录。
- **P8**：发布集合同（`release-set.ts`/`upgrade-state.ts`/release workflow）、固定升级
  顺序与 checkpoint 恢复、退役默认域写入端点（`retired-endpoints.json` + 410）、
  隔离演练启动器（每 run 唯一 project/端口/资源标签，专属隔离 Docker daemon）、
  真实升级+备份恢复演练；生产环境不在本次自动执行范围。

## 5. 已知既有失败（接手时不要误判为本轮引入）

以下失败在 P3 起点基线 `wlusvxwn` 已复现（曾在一次性 `jj workspace add` 中验证）：

- `test:domain problems`：4 failed（`objective.test.ts:209/306/733`、
  `problem-contest-secrecy.test.ts:374`）；
- `test:domain evaluations`：2 failed（`result-drain.pg.test.ts:17`、
  `versioning-job-skipped-source.pg.test.ts:881`）。

修复它们属于 P3/P4 工作范围之外的历史问题；若顺手修复，需单独 change 并注明基线。

## 6. 硬约束（与交接文档一致，违反即回退）

1. 禁止直接推送 `main`；不重写 P0 冻结混合祖先链；保留 P2b 签名检查点 `e6f391b5`。
2. 所有提交 GPG 签名、中文提交信息；优先 jj；每个逻辑单元一个 change。
3. 禁止手改历史 SQL、`_journal.json`、`deno.lock`、`Cargo.lock`；新迁移必须由
   drizzle-kit 生成。
4. 只能操作自己创建的隔离测试资源；**不得操作已有生产/开发服务**（PostgreSQL、Redis、
   MinIO、Judge 容器、`noj-main117-*`、`noj-arch-p2b-*` 等），不得清空/FLUSH 开发 Redis。
5. Core DB 测试必须走 `deno task test:domain` / `bash scripts/test-shared.sh` /
   `deno task test:parallel`；Gateway 集成测试走 `deno task test`（启动器）。
6. 文件修改使用 DSH 的 `read`/`edit`/`write` 工具，不用脚本批量改写。
7. 不通过忽略/早退/mock 代替必需的真实依赖测试；未执行项目必须逐项说明。
8. 未满足批次的放行条件时保留成果、显式列缺口，不勾选完成，不把剩余事项藏进
   「后续优化」。

## 7. 测试环境与命令

### 7.1 当前已存在的隔离资源（本轮创建，可直接复用）

| 资源 | 值 |
|---|---|
| PostgreSQL 容器 | `noj-arch-p3test-p31021130439-postgres`（宿主 `127.0.0.1:32928`） |
| Redis 容器 | `noj-arch-p3test-p31021130439-redis`（宿主 `127.0.0.1:32929`） |
| Core 测试环境脚本 | `/tmp/noj-p3-testenv.sh` |
| Gateway 测试环境脚本 | `/tmp/gw-testenv.sh` |
| 测试存储目录 | `/tmp/noj-p3-test-storage` |

`/tmp/noj-p3-testenv.sh` 内容（如文件丢失可重建）：

```bash
export TEST_PG_ADMIN_URL='postgres://noj:noj@127.0.0.1:32928/postgres'
export TEST_REDIS_URL='redis://127.0.0.1:32929/0'
export TEST_STORAGE_ROOT='/tmp/noj-p3-test-storage'
export JWT_SECRET='p3-test-secret-0123456789abcdefghijklmnop'
```

`/tmp/gw-testenv.sh` 内容：

```bash
export NOJ_GATEWAY_TEST_DATABASE_URL='postgres://noj:noj@127.0.0.1:32928/postgres'
export NOJ_GATEWAY_TEST_REDIS_URL='redis://127.0.0.1:32929/0'
export NOJ_GATEWAY_TEST_REDIS_PREFIX='noj-gw-p5-test:'
```

### 7.2 若容器已不存在（重建隔离资源）

只允许自建带 owner 标签的新容器/临时目录；不复用开发端口 5432/6379。测试启动器
要求显式提供上述环境变量，不读取开发 `.env`。

### 7.3 当前 tip 的基线验证命令

```bash
# Core 类型与门禁
cd /home/xyber-nova/.codex/worktrees/noj-architecture-p3/noj-core
deno check --frozen src/main.ts tests/types/*.ts
deno task test:gates

# 结构扫描（当前预期数字见 §3）
cd /home/xyber-nova/.codex/worktrees/noj-architecture-p3
deno run -A scripts/check-module-boundaries.ts

# Gateway（最新已验证 171 passed / 0 failed / 1 ignored，
# run id rmvi1iili79e8bc191ec8）
cd noj-llm-gateway
deno task check
source /tmp/noj-p3-testenv.sh   # 供测试启动器读取 TEST_PG_ADMIN_URL / TEST_REDIS_URL
deno task test
```

单模块 Core 测试示例：

```bash
cd noj-core && source /tmp/noj-p3-testenv.sh && deno task test:domain runtime
```

注意：Core DB 测试**禁止**直接拼 `deno test`（会因 `DATABASE_URL` 未设置拒绝执行）。

## 8. 交回材料要求（批准方案 §9.3）

1. 代码与版本：P3–P8 分批签名提交及 bookmark；每批改动说明与 Agent Note。
2. 验证记录：精确 commit/change ID、命令、退出码、测试项、资源 run ID；单元 /
   真实 PG / 真实 Redis / 真实 Docker / mock 上游 / 浏览器 / 升级恢复分别记录；
   ignored、失败、未执行逐项解释；原始日志留在本地制品目录，不提交秘密与临时日志。
3. 同步文档：计划跟踪清单、目标架构/owner、任务恢复与监控、Gateway 政策迁移、
   协议 v3、发布集与升级恢复手册、接口退役表、UI/IDE 合同、测试与 CI 元数据；
   修正「启动自动迁移」「Cookie 提供权限」等过时描述。
4. 最终报告：哪些批次通过全部验收、哪些仅实现/仅定向验证、哪些失败或缺资源未执行、
   生产环境未操作的明确记录、可复核的提交与证据索引。

## 9. 结束时资源清理

本轮创建的隔离资源（仅在本轮全部测试完成后清理，且只按精确名称删除）：
`noj-arch-p3test-p31021130439-postgres`、`noj-arch-p3test-p31021130439-redis`、
`/tmp/noj-p3-test-storage`、`/tmp/noj-p3-testenv.sh`、`/tmp/gw-testenv.sh`、
遗留 scratch 数据库（如 `noj_test_dbg*_manual`）与 `/tmp` 验证脚本/日志。
不要把开发/生产容器当作本轮资源删除。
