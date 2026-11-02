# NOJ 测试性能优化实施计划（CI / 本地 / E2E）

Status: in-progress Baseline commit: `be1ee7b51` Owner: 测试基础设施（P0—P7）
Scope: noj-core 测试启动器、共享 helper、Browser E2E、CI 选择器与本地运行入口

---

## 1. 目标与基线

本计划按"先减少测试内部实际工作量，再优化调度与复用"的顺序推进：

1. 先建立可归因的测量（P0），避免把"测试变少 / 单用例变快 /
   并行度增加"混为一谈；
2. 再消除测试内部的固定等待、重复探测、重复 reset 与重复启动（P1—P4）；
3. 最后调整分片、CI 选择与本地会话（P5—P6），并用性能门禁固化（P7）。

已知基线（`be1ee7b51`）：

| 项目                       |                             已观察到的成本 | 性质                   |
| -------------------------- | -----------------------------------------: | ---------------------- |
| Browser job                |           约 475 秒，其中测试命令约 391 秒 | CI 日志                |
| Core Sharded job           |           约 829 秒，其中测试步骤约 794 秒 | CI 日志                |
| Redis 生产环境撤销检查测试 |                               单次约 31 秒 | 日志与重试配置相符     |
| LLM 治理 Browser 测试      | evaluator 每次固定休眠 20 秒，两轮约 40 秒 | 实现核查               |
| Core 公共数据库 reset      |                         481 个直接调用位置 | 静态统计，累计耗时待测 |

仓库固定 Deno v2.9.5（`.dvmrc`）。所有正式基线与验收使用 `.dvmrc` 版本，
不把运行时升级混入本次优化。

生产 HTTP API、数据库 schema、评测协议保持现有契约。生产代码改动限定为种子
批量写入，其余改动位于测试与工程工具。

## 2. 批次与依赖

| 批次 | 内容                                     | 依赖           |
| ---- | ---------------------------------------- | -------------- |
| P0   | 统一计时、测试清单与基线报告             | 无             |
| P1   | 等待 helper 与 Redis 故障测试            | P0             |
| P2   | LLM 治理显式同步屏障                     | P0、P1         |
| P3   | Core reset 与种子批量写入                | P0             |
| P4   | 浏览器生命周期与题包夹具                 | P0、P2         |
| P5   | Core 分片与 CI 去重、影响范围选择        | P0、P3         |
| P6   | Browser 分片、本地隔离会话与构建产物复用 | P1、P2、P4、P5 |
| P7   | 每日和候选发布性能门禁、总体验收         | 前述批次       |

每批单独提交和审查；保留现有 GitHub-hosted Runner。PR 按影响范围执行并保留
必要跨模块检查；main 与候选发布执行全量功能测试；性能基准每日与候选发布执行。

## 3. P0：可归因的测量与覆盖清单

### 文件

| 文件                                                          | 改动                                             |
| ------------------------------------------------------------- | ------------------------------------------------ |
| `scripts/lib/test-timing.ts`（新增）                          | 统一阶段计时与 JSONL 记录                        |
| `scripts/test-baseline.ts`、`scripts/test-baseline_test.ts`   | 支持 Core / Browser / API E2E 重复测量与报告     |
| `scripts/test-performance-report.ts`、对应 `_test.ts`（新增） | 聚合计时、JUnit 与运行清单                       |
| `noj-core/tests/helpers/db.ts`                                | reset 各阶段计时（P3 同时改造批量写入）          |
| `noj-core/scripts/test-launcher.ts`                           | 模板迁移、克隆、child、清理计时（P5 重构时落地） |
| `noj-tests/scripts/test-runner.ts`（新增）                    | 统一 API / Domain / Browser 启动与运行清单       |
| `noj-tests/deno.json`、`noj-tests/scripts/run-e2e-domain.sh`  | task 转入统一启动器                              |
| `scripts/gate-list.ts`                                        | 注册新增工程工具测试                             |

### 计时接口

```ts
export interface TestTimingRecord {
  version: 1;
  runId: string;
  shard: string;
  phase: string;
  durationMs: number;
  success: boolean;
  file?: string;
  caseName?: string;
  count?: number;
}

export function measurePhase<T>(
  phase: string,
  fn: () => Promise<T>,
  tags?: { file?: string; caseName?: string; count?: number },
): Promise<T>;
```

规则：

1. `performance.now()` 计时；异常经 `finally` 记录后原样传播。
2. 默认关闭；启动器把 `--profile` 转成 `NOJ_TEST_PROFILE=1`。
3. 每个测试 isolate 写独立 JSONL，文件名包含 shard、PID 与随机标识。
4. 只记录测试标识、阶段、耗时和计数；禁止 token、密码、连接串、请求内容。
5. 输出目录由启动器提供：`test-results/performance/<runId>/`。
6. 落盘失败不能让测试失败（诊断能力，不是断言）。

阶段至少覆盖：

| 子系统      | 阶段                                                                       |
| ----------- | -------------------------------------------------------------------------- |
| Core 启动器 | template migration、template seed、DB clone、Redis acquire、child、cleanup |
| Core reset  | ownership check、truncate、root、RBAC、workspace、images、rankings refresh |
| E2E helper  | account preparation、bundle build、Judge probe、submission wait、job wait  |
| Browser     | launch、context create、login preparation、journey step、diagnostic、close |

### 运行报告

必须同时保存：

- 完整命令、提交 SHA、Deno 版本、Runner 信息与并发度；
- 发现 / 选择 / 实际执行的测试文件列表；
- JUnit 结果与通过、失败、跳过数量；
- 总耗时、逐文件耗时、公共 helper 累计耗时、最慢用例；
- reset、账号创建、Judge 探测、浏览器启动与轮询次数。

JUnit 由启动器写入自己拥有的报告目录，保留终端输出；以仓库固定 Deno 版本
验证参数兼容性（<https://docs.deno.com/runtime/reference/cli/test/#reporters>）。

### task 接口

保留既有入口：

```bash
deno task test
deno task test:domain <domain> [--filter ...]
deno task test:browser [--filter ...]
```

新增：

```bash
deno task test:logic
deno task test:baseline --suite <core|browser|api> --repeat 3
```

`noj-tests` 的零依赖 helper 测试放入 `tests/unit/`，由 `test:logic` 执行。

### 验收

- child 失败时报告记录失败并保留原退出码；模板初始化失败与清理失败都进入报告。
- 两个同时运行的测试进程不覆盖报告。
- 报告能区分"测试变少""单用例变快""并行度增加"。
- 新增测试全部进入 task 或 `GATE_SELF_TESTS`。

P0 合入后先生成一份未优化基线，后续批次使用同一套测量逻辑比较。

## 4. P1：等待 helper、Judge 探测与 Redis 故障测试

### P1-A 统一异步等待

文件：`noj-tests/e2e/helper.ts`、`noj-tests/fixtures/wait.ts`（新增）、
`noj-tests/tests/unit/wait.test.ts`（新增）。

```ts
export interface WaitOptions {
  timeoutMs: number;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
}

export function waitUntil<T>(
  read: (signal: AbortSignal) => Promise<T>,
  isDone: (value: T) => boolean,
  options: WaitOptions,
): Promise<T>;
```

行为：

1. 首次立即读取；未完成时依次等待 100、250、500、1000 毫秒，此后每秒读取。
2. 使用绝对截止时间；单次请求默认最多 5 秒，且不超过剩余总预算。
3. 请求、JSON 解析与等待均计入总预算；成功后不再创建计时器或请求。
4. 401/403/404 等确定性错误立即报错；网络故障与 5xx 在预算内重试并保存最后错误。
5. 超时错误包含资源 ID、最后状态、最后 HTTP 状态、读取次数与实际耗时。
6. 迁移 `pollSubmission()`、`waitForJobCompleted()`、`waitForServer()`；保留原有
   位置参数签名，把 `maxRetries × intervalMs` 转成总预算。
7. 提交等待保留 `allowErrorResult`；重评测先等对应 job 终态，再检查提交与本次
   attempt，不能因旧 attempt 已 finished 提前成功。

测试：首次即完成无 sleep；读取耗时计入预算；卡住请求可取消；404 立即失败、 短暂
503 后恢复；截止后无遗留请求；旧 attempt 已完成而新重评测未完成时不提前返回。

### P1-B Judge canary 前移

文件：`noj-tests/scripts/test-runner.ts`、`noj-tests/e2e/helper.ts`，以及
`e2e/cross-domain/pipeline.test.ts`、`e2e/contest/contest_lifecycle.test.ts`、
`e2e/catalog/import_bundle.test.ts`、`e2e/catalog/tags.test.ts`。

启动器在需要 Judge 的运行中只执行一次 canary：

1. 用本次运行独立的公开题包夹具提交正确解答；
2. 确认 attempt 被实际领取并得到预期完成结果；
3. 把提交 ID、attempt ID、完成结果写入运行清单；
4. child 从清单读取准备结果，不重复提交探测任务；
5. 业务用例继续验证自己的真实评测结果。

正式 task 中 Judge 不可用直接失败；删除"探测失败直接 return、最终显示通过"分支。

验收：每次隔离运行一次 canary；只有 error 状态、无领取证据不算可用；canary 后 停
Judge，真实评测仍失败；伪造/不匹配 run 清单被拒绝。

### P1-C Redis 生产撤销检查 31 秒等待

文件：`noj-core/src/modules/access/identity/tests/lib/revokedTokens.test.ts`、
`noj-core/tests/helpers/redis-resp.ts`（新增）、
`noj-core/tests/shared/runtime/redis-resp.test.ts`（新增）。

测试专用 RESP 服务：绑定 127.0.0.1 随机端口；解析分段到达的命令；支持 ioredis
初始化使用的 PING、INFO、CLIENT、SELECT、QUIT；收到目标 EXISTS 立即返回约定
Redis 错误并记录 key；显式 `close()` 关闭 listener 与已接受连接。

重写 bypass 测试：关闭当前 Redis 单例并保存环境变量 → 设置
`NOJ_ENV=production`、 `NOJ_BYPASS_JWT_REVOKE=1`、默认 Redis URL 指向该服务 →
调用 `isJtiRevoked(jti)` （**不传显式 Redis
参数**，否则绕开受保护的默认客户端分支）→ 断言收到 EXISTS 且 抛
`ServiceUnavailableError` → finally 关闭客户端与服务、恢复环境与正常连接。

保留真实连接不可用测试与真实 TTL 过期测试。目标 < 5 秒；移除生产环境保护条件时
测试必须失败；结束后无遗留连接或重连计时器；不修改生产重试策略。

## 5. P2：LLM 治理显式同步屏障

文件：`noj-tests/e2e/browser/_workspace-llm-governance-fixture.ts`、
`workspace-llm-model-governance.test.ts`、`scripts/e2e/test_coordinator.py`（新增）、
`scripts/e2e/check_test_coordinator.py`（新增）、`noj-tests/fixtures/evaluation-gate.ts`、
`docker-compose.e2e.yml`、`.github/actions/e2e-domain/action.yml`、`env.e2e.template`。

协调服务使用 Python 标准库 `ThreadingHTTPServer` + 条件变量，支持并发等待与释放
（单线程 `HTTPServer` 会让等待请求阻塞释放请求）。

| 接口                                   | 行为                                         |
| -------------------------------------- | -------------------------------------------- |
| `POST /gates`                          | 创建 run 所属关闭状态 gate；重复 ID 返回 409 |
| `GET /gates/<id>`                      | 返回到达数量、释放状态、取消状态             |
| `GET /gates/<id>/wait?arrival=<nonce>` | 记录到达并等待释放；相同 nonce 不重复计数    |
| `POST /gates/<id>/release`             | 幂等释放                                     |
| `DELETE /gates/<id>`                   | 取消等待并清理                               |
| `GET /health`                          | 健康检查                                     |

服务只加入专用 evaluator 网络，管理端口绑定 loopback；分别提供主机 URL 与
evaluator 内部 URL，不能把主机 localhost 写进 evaluator。

测试顺序：创建唯一 gate 并写入 evaluator 夹具 → evaluator 调真实
`llm.complete()` 前等待 gate（删除 `time.sleep(20)`）→ 提交 A、B → 等待至少一个
evaluator 到达， 确认两条尝试仍在 queued/judging 并验证 A 冻结快照 → 经原 UI
修改 A 模型别名 → 释放 gate，等待两次评测完成并验证原模型、域归属、用量 → 再提交
A，gate 立即通过， 验证新尝试用新模型 → 保留快照不变与 Mock
上游收到正确模型的断言 → finally 释放删除。

只等一个 evaluator（兼容 Judge 并发 1，等两个会死锁）；屏障上限 45 秒（短于
evaluator 60 秒限制）；协调服务缺失、gate 不存在、等待超时都必须失败。

验收：Judge 并发 1/2 通过；改模型前人为加 5 秒 UI 延迟仍稳定；跨 run gate
互不释放； UI 步骤抛错后无长期阻塞 evaluator；两轮固定休眠消除且真实断言保留；原
llm_mock 只读检查接口契约不变。

## 6. P3：Core reset 与种子批量写入

文件：`noj-core/tests/helpers/db.ts`、`seed-rbac.ts`、`seed-system.ts`、
`src/modules/platform/system/tests/services/seed-rbac.test.ts`（新增）、扩展现有
`seed-system.test.ts`、`noj-core/tests/db/reset-db.test.ts`（新增）。

第一轮继续"完整清表 → 正式种子"，不引入事务回滚或测试专用 RBAC 数据。

| 函数/阶段              | 写法                                                                  |
| ---------------------- | --------------------------------------------------------------------- |
| `ensureSystemRoles`    | 两条角色一次 `values([...])`                                          |
| `ensurePermissions`    | 全量权限一次批量 upsert                                               |
| user/admin 默认权限    | 读现有角色与权限后构造数组，各一次批量 insert                         |
| `migrateExistingUsers` | `INSERT ... SELECT ... WHERE NOT EXISTS (...) ON CONFLICT DO NOTHING` |
| 敏感权限首次撤销       | 一次集合 delete，再写原有标记                                         |
| `seedJudgeImages`      | 批量 upsert                                                           |
| helper 的三条兼容镜像  | 一次批量 insert                                                       |

必须保持：权限按 `(resource, action)` 冲突只同步描述、保留原
ID；描述未变不更新； 角色按现有 name 查真实
ID；已有任意角色的用户不补默认角色；敏感权限撤销标记存在时
保留管理员后续显式授权；镜像冲突保持现有更新集合（不覆盖原本不更新的 image）；
空数组不发无效 INSERT；reset 所有权检查、真实库名复核、榜单刷新选项继续生效；
系统设置缓存继续走现有 reset 接口。

验收：空库初始化、重复 seed、改描述后再 seed 语义一致；自定义角色
ID、用户已有其他 角色、管理员重新授权敏感权限有回归；普通 reset / 带榜单刷新 /
错误 ownership 覆盖； 干净库连续 reset 30 次比较中位数与 P95；中位耗时至少降低
50%，未达标时用 P0 数据解释 剩余成本（不计分片收益）。

## 7. P4：浏览器生命周期与题包夹具

文件：`noj-tests/e2e/browser/browser.ts`、所有使用该 helper 的 journey、
`ui_flows.test.ts`（移除重复
launch/teardown）、`noj-tests/fixtures/problem-bundle.ts` （新增，已由 Lead
先行落地）、`noj-tests/fixtures/coding-problem.ts` 与 LLM fixture （P2 owner
负责该文件）统一 builder，新增 `noj-tests/tests/unit/` 测试。

```ts
export async function withBrowserJourney(
  label: string,
  fn: (fixture: BrowserJourneyFixture) => Promise<void>,
): Promise<void>;

export interface BrowserJourneyFixture {
  newSession(actorLabel: string): Promise<BrowserSession>;
}
```

生命周期：每个顶层 journey 一个 Chromium；每个角色/独立场景一个 BrowserContext；
多角色共用 Browser 但各自 Cookie/storage/trace；session teardown 只关 context，
journey 的 finally 关 Browser；第二个 context 创建失败也要清理第一个 context 与
Browser；trace/截图文件名含 run、journey、actor；保留 Nuxt hydration 等待；
`ui_flows.test.ts` 保留独立用例名与独立上下文。

题包 builder 使用
`fflate@0.8.2`：`buildProblemBundle(files: Record<string, string | Uint8Array>): Uint8Array`。
只处理普通文件夹具；恶意 ZIP、路径穿越、压缩格式、损坏包继续自行构造输入。

夹具复用限定当前 journey：账号/token 可复用；已发布不可变题目 fixture 显式返回
`problemId/versionId/reference/domain`；注册、改密、撤权、切身份、发布新版本用独立
状态；不缓存"当前最新版本"；不共享可变用户状态到其他 journey；同层互不依赖的账号
准备并发上限 2。

验收：四角色 journey 的 Browser 启动从 4 次降为 1 次；A 登录/退出不影响
B；失败时 有对应 actor 的 trace
与截图；Browser/context/业务步骤/诊断任一失败都能清理；题包用
真实导入、发布、下载、评测链路验收。

## 8. P5：Core 分片与 CI 影响范围

### P5-A 以实际测试文件分片

文件：`noj-core/scripts/test-parallel-shards.ts`、`test-launcher.ts`、
`test-launcher-args.ts`、`test-parallel-args.ts`、`test-parallel*.test.ts`、
`test-launcher.test.ts`、`scripts/module-test-metadata.ts`、
`dev-docs/engineering/test-duration-baseline.json`（新增）。

算法：从模块元数据与 shared roots 发现实际测试文件 → 排除登记的性能基准 → 路径
规范化去重 → 按 P0 文件耗时降序分配到当前累计最少的分片（同耗时按路径排序）→
新文件用基线中位文件耗时估值 → 执行前保存分片计划到报告 →
`tests/00_migrate_test.ts` 是唯一允许跨 DB 分片重复的例外，其他文件恰好一次。

参数：`--shards N` 划分全部所选测试为 N 片；`--jobs M` 同时运行最多 M 片；
`--dry-run` 输出选择与资源计划不建资源。默认 `--shards 4 --jobs 2`。修正
`--shards 1` 通过截断清单漏跑业务测试的行为。每片独立
DB/Redis/storage，片内串行， 禁止 child `--parallel`。

验收：N=1/2/4 除例外外集合相等无重复；增删改名后覆盖守卫发现正确集合；任一 child
失败整体非零且其他 child 资源仍清理；`--dry-run` 无外部依赖变量也能运行。

### P5-B 影响范围选择与 Core 去重

文件：`scripts/select-core-ci.ts` 及测试、`scripts/module-test-metadata.ts`、
`dev-docs/engineering/module-boundaries.json`、`.github/workflows/ci.yml`、
`.github/workflows/e2e.yml`。

- 直接接收 PR 变更路径，处理新增/删除/重命名前后路径，不依赖过时 `src/domains/*`
  过滤。
- Core 测试文件单独变更：所属模块测试 + 固定契约检查。
- Core 生产模块变更：所属模块 + 反向依赖闭包（合并 base/head 依赖），附加
  Browser 与 cross-domain。
- shared/schema/迁移/启动器/模块映射/无法归属：全量 Core。
- 依赖锁文件、测试基础设施、共享夹具：全量相关模块/E2E。
- main/手动全量/候选发布：全量功能测试。解析失败或无法解释路径扩大到全量，不输出空选择。
- E2E
  模块映射写入统一元数据：access→identity/admin/rate-limit，problems→catalog/objective，
  evaluations→submission/objective，contests→contest，communication→community；
  education/read-models 等跨模块能力附加
  Browser/cross-domain；application/http/runtime 与通用基础设施变更选择全部 API
  E2E。
- Core 回归统一由 Core Sharded 执行；移除重复 legacy domain job；`test:domain`
  保留为 本地兼容入口；更新元数据 CI
  映射与守卫测试（断言最终行为，不是字符串包含）。

验收：每个目标模块构造新增/修改/删除/重命名样例；覆盖 workspace
等多目标旧别名；以 真实文件集合审查；同一文件不同时在 legacy job
与完整分片执行；未知路径触发全量并说明原因。

## 9. P6：Browser 分片、本地隔离会话与构建产物复用

### P6-A Browser 三组

文件：`noj-tests/scripts/test-runner.ts`、`noj-tests/scripts/test-plan.ts`（新增）及单测、
`.github/workflows/e2e.yml`、`.github/actions/e2e-domain/action.yml`。

以 Browser 测试文件为最小单元按同一耗时基线分三组，文件内 journey 不拆。每组独立
Compose 栈，禁止三 child 共用一个数据库或共享可变管理状态。新增
`e2e-browser-shard` matrix job，保留聚合 job
`E2E Browser`：有选中测试时全部组必须成功；未选中时明确记录
原因；缺失/取消/失败不能聚合成功；artifact 名含 shard，计时与诊断产物始终上传。

### P6-B 本地隔离会话与构建产物复用

文件：`scripts/e2e/session.ts` 及测试、`setup.sh`、`teardown.sh`、`run-all.sh`、
`core.sh`、`check-setup.sh`、`docker-compose.e2e.yml`、`docker-compose.e2e-s3.yml`、
`noj-tests/deno.json`、统一启动器与 composite action。

新增：

```bash
deno task env:up --session <name> --fresh
deno task env:down --session <name>
deno task test:browser --session <name>
deno task test:domain <domain> --session <name>
```

要求：session 名有限字母数字连字符；实际 run ID
加随机后缀；清单保存项目名、owner ID、 端口、资源池、镜像 digest、UI/package
fingerprint；移除固定 container_name，用 `docker compose ps -q <service>` 取容器
ID；evaluator 网络按 run 命名并传实际网络名；
主机端口参数化且冲突重试，实际端口写清单；保留 `noj-e2e-llm-mock` 内部 DNS alias
但由 网络隔离；测试使用的 Redis 容器 ID、DB URL、Gateway URL、协调服务 URL
全部由清单传入； 清理前核对 session/Compose project/owner label；删除全局
`/tmp/noj-e2e-env.sh` 依赖； 同名 session 拒绝覆盖。

复用 SDK/应用镜像 BuildKit 缓存、UI 构建与题目支持包；UI/支持包缓存含输入
fingerprint 与产物摘要，命中时同时验证，输入变化或产物损坏即重建；本地复用
session 报告标明 reused-session，不与 clean-run 混合；保留 CI
五类镜像构建一次、Docker tar artifact 分发； Judge 构建缓存 `mode=max`，fork PR
保持受限分支。

验收：两个本地 session
并行无端口/容器/网络/数据冲突；关闭一个不影响另一个或开发栈；
SDK/UI/锁文件/题目源变化正确失效；损坏缓存重建不执行旧产物；中断/启动失败/测试失败后
清理范围可审计。

## 10. P7：性能门禁与总体验收

### 工作流

新增 `.github/workflows/test-performance.yml`；修改
`ci.yml`、`e2e.yml`、`release.yml`； 更新测试文档与 Agent Notes。

现有 Core Perf job 移入可复用工作流：每日北京时间 02:00 执行一次，可手动指定
ref； 候选发布调用同一工作流；保留现有性能断言与专用数据准备；wall-clock
只用于趋势和人工 验收，不用共享 Runner 单次波动阻断 PR。CI/E2E 增加
`workflow_call` 与 ref 输入；候选 发布先固定提交 SHA，在该 SHA
上跑全量功能、E2E、性能，再进入发布写入；`cleanup_existing=true`
的既有清理流程保持独立。

### 正确性验收命令

```bash
cd noj-core
deno task test:logic
deno task test:gates
deno task test:domain access --filter=revokedTokens
deno task test:domain platform --filter=seed
deno task test:shared --filter=reset-db
deno task test:parallel --shards 4 --jobs 2 --profile

cd ../noj-tests
deno task test:logic
deno task env:up --session perf-clean --fresh
deno task test:browser --session perf-clean --profile
deno task test:domain submission --session perf-clean --filter=e2e/rejudge --profile
deno task env:down --session perf-clean
```

工程检查：Core 与 noj-tests 的格式、lint、相关类型检查；`deno task test:gates`
覆盖选择器、 分片、基线报告、session
所有权与测试发现；`bash scripts/e2e/check-setup.sh`；Python 协调 服务与原 LLM
Mock 契约；actionlint；文档链接、Agent Note 格式与模块边界门禁。

### 性能验收

| 比较         | 固定条件                             | 目的                       |
| ------------ | ------------------------------------ | -------------------------- |
| 内部优化前后 | 相同测试集合、并发、Runner、计时配置 | 验证 helper 与夹具变快     |
| 编排优化前后 | 相同测试集合、记录分片与并发         | 验证 CI 墙钟与 Runner 消耗 |

完整 Core 与 Browser 各跑优化前后三次；定向用例连续 20 次；记录中位数与范围。

| 项目                          | 目标                               |
| ----------------------------- | ---------------------------------- |
| Redis bypass 安全测试         | < 5 秒，保留默认客户端分支证明     |
| LLM 治理                      | 移除两轮固定休眠，真实链路断言保留 |
| Core reset                    | 30 次采样中位耗时降 ≥ 50%          |
| 内部优化后 Browser 测试阶段   | 同并发较 391 秒降 ≥ 20%            |
| 分片后 Browser 最慢组         | ≤ 4 分钟                           |
| 优化后 Core Sharded           | ≤ 6 分钟                           |
| 热缓存全量 E2E workflow       | ≤ 7 分钟                           |
| main 全量功能检查 Runner 消耗 | 较原基线降 ≥ 30%                   |

目标是工程验收目标，不是已取得收益；未达标必须列出剩余阶段成本与原因，功能正确但
性能未达标不能标记"性能验收完成"。

### 审查证据

| 领域         | 证据                                                 |
| ------------ | ---------------------------------------------------- |
| 覆盖没有缩水 | 前后测试文件集合、用例对照、跳过原因差异             |
| 安全行为保持 | Redis bypass 反向验证、真实连接失败与 TTL 测试       |
| 并发语义正确 | Judge 并发 1/2、跨 run 屏障隔离、重评测 attempt 关联 |
| 数据隔离正确 | 分片资源清单、错误 owner 拒绝、双 session 清理       |
| 种子语义等价 | 权限 ID、描述更新、已有用户角色、敏感权限重新授权    |
| 诊断能力保持 | 失败 trace、截图、最后状态、清理错误                 |
| 性能结论可信 | 原始报告、固定版本、三次完整比较、内部与分片收益分列 |

竞赛自然结束、真实 Redis
TTL、沙箱超时等以真实时间为验证对象的测试保留；不采用倒改
数据库时间或生产测试后门。

## 11. 文档与提交收口

- 本计划：`dev-docs/superpowers/plans/2026-11-03-test-performance.md`
- `dev-docs/engineering/testing.md`
- `noj-tests/E2E_TESTING.md`
- 本地 E2E 配置示例与 task 说明
- `.agents/notes/implemented/testing/` 实现记录（只记录已完成并验证的批次）

每个 PR 描述包含具体问题、最终行为、验证命令、性能对比与剩余限制。执行时优先使用
jj，从主题分支提交，确认 GPG 签名可用后再修改代码；所有变更通过 PR 合入。

## 12. 实施状态（2026-11-03）

| 批次 | 状态   | 已验证证据                                                                                                                     | 未完成/限制                                                            |
| ---- | ------ | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| P0   | 已落地 | 计时 JSONL、manifest、JUnit、报告聚合与对比；Core 4 片 2 并发绿色全量 5m22s（2427 tests/0 failed）；test:baseline 端到端 5m16s | 正式三次基线需在固定 Deno 2.9.5 环境重跑                               |
| P1   | 已落地 | 等待器 8 条单测；Redis 生产 bypass 用例 6ms（旧约 31 秒）；canary 真实栈 2.1 秒完成并写入 manifest                             | 重评测/四文件 canary 读取未在全栈逐条跑                                |
| P2   | 已落地 | 协调服务 8 条契约用例；真实 Browser 9 步 19 秒通过；固定 40 秒休眠移除                                                         | Judge 并发 1 与「UI 加 5 秒延迟」未实跑                                |
| P3   | 已落地 | 30 次 reset 中位 34.9ms、P95 40.2ms（旧实现 645.4/780.7ms，约 -94.6%）；语义/回滚用例通过                                      | 真实数据下 reset 仍有慢尾（P95 约 1 秒）；DELETE 死元组依赖 autovacuum |
| P4   | 已落地 | Browser 启动 34→24；四角色 4→1；失败诊断按 actor 命名；60 条零依赖单测                                                         | 其余 Browser journey 未在真实栈重跑                                    |
| P5   | 已落地 | N=1/2/4 集合相等无重复；选择器 16 用例；CI 删除 16 个重复测试 job；dry-run 无 TEST_* 可运行                                    | actionlint 未本机运行；真实 4/2 全量已在本地跑通（见 P0）              |
| P6   | 已落地 | Browser 三组 matrix + 聚合 job；session 17 单测；真实会话 up→rejudge(6s)→down 全链路通过；双会话容器隔离；产物指纹+摘要缓存    | 全栈双会话并行（每套 migrate+seed 25–30 分钟）未跑                     |
| P7   | 已落地 | 每日性能工作流、候选发布功能/E2E/性能门禁、文档与 4 篇 Agent Note                                                              | CI 未实际触发；候选发布门禁需首次预发布验证                            |

本轮本地验证使用 Deno 2.9.8（本机未安装 .dvmrc 的 2.9.5）；正式性能结论仍需在
固定版本 Runner 上重跑并归档原始报告。
