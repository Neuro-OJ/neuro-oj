# 权限与功能简化：全面评审及补齐实施计划

> 基线：PR #717（https://github.com/Neuro-OJ/neuro-oj/pull/717），提交
> `b3ece1b28f690d40781b871e0a5979a20404664f`，base `rc/v0.11`。
> 本文件是仓库内的稳定实施记录；Agent Note 与验收证据都链接到这里，不再引用
> 用户缓存路径。

## 一、评审结论

固定角色、独立复制、功能删除的主体实现已经存在，可以继续补齐，不需要推倒重做。
但当前实现**尚不满足合并条件**，剩余工作包含真实代码缺口：

| 优先级 | 发现                                                                                         | 处理结论                             |
| ------ | -------------------------------------------------------------------------------------------- | ------------------------------------ |
| P1     | 管理员保护锁只接入角色变更；封禁分步写库、管理员注销用另一套行锁、自助注销没有最后管理员守卫 | 统一事务与锁顺序                     |
| P1     | 社区通知过滤仍读 `configuration.features.community`                                          | 由域类型 + 实例政策推导              |
| P1     | 后台用户页/创建账号/域成员页仍用 `role_ids` 与复数 `/roles`                                  | 完成单值角色前端合同                 |
| P1     | 资源 composable 仍调 `/shared-resources`、`/sharing`，后端缺 `/copy-sources`                 | 补来源目录并替换旧共享 UI            |
| P1     | 题目复制先锁域、再经创建服务锁账号                                                           | 固定“账号先于域”，真实 PG 双连接验证 |
| P1     | 升级在预检通过后失败仍发布目标文件；暂存 compose 未固定项目目录                              | 修复升级状态机与恢复                 |
| P1     | 旧库预检只数 ledger 条数，未校验完整前缀                                                     | 迁移前逐条校验 hash/时间戳/顺序      |
| P2     | 绑定 schema 仍有 owned/shared 与 `domain_training_bindings`                                  | 收敛到数据库约束与统一模型           |
| P2     | `StoredDomainPreset` 仍保留 `custom` 兼容分支                                                | 只保留三种固定域类型                 |
| P2     | E2E 夹具仍创建自定义 RBAC、调用 `/roles`；SSR 断言仍要求已删除随机题块                       | 更新验收合同                         |
| P2     | Agent Note 状态与证据口径不准确                                                              | 重建按提交/场景/环境归属的证据       |

## 二、固定对外合同

| 对象           | 合同                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------- |
| 平台角色修改   | `PATCH /api/v1/admin/identity/users/:id/role`，请求 `{role:"user"                        |
| 域成员角色修改 | `PUT /api/v1/domains/:slug/members/:userId/role`，请求 `{role:"member"                   |
| 负责人交接     | `POST /domains/:slug/transfer`；普通角色赋值不能获得 owner                               |
| 用户/成员 DTO  | 单值 `role`；`is_admin` 仅为派生展示字段                                                 |
| 域配置         | 只存 `access/discoverable/join_policy`；有效 `features/homepage` 由类型与实例政策推导    |
| 复制来源目录   | `GET /api/v1/domains/:slug/copy-sources?kind=problem                                     |
| 题目复制       | `POST /domains/:slug/problem-bindings`，请求 `source_ref`、可选 `version_id`             |
| 题单复制       | `POST /domains/:slug/training-bindings`，请求 `training_id`；行为是独立复制              |
| 邀请           | 只接受 `email`/`general`；单次邀请使用 `general + max_uses=1`                            |
| 删除接口       | 角色/权限 CRUD、板块角色授权、共享设置、旧共享目录与训练时间窗接口返回 404，不建兼容转发 |

错误语义：非法角色、数组角色、普通赋值 owner、`mode=once` → 400；权限不足 →
403； 按既有隐藏规则不可见 → 404；revision、负责人状态、最后管理员冲突 →
409，其中 最后管理员使用稳定错误码 `LAST_ADMIN`。

## 三、实施批次

### 第 1 批：基线与合同测试

1. jj 工作副本、bookmark、PR head 与基线一致，GPG 可用。
2. 本文件入库；Agent Note 链接本文件。
3. 合同测试：平台单角色、域单角色、有效
   owner、删除端点、配置三键、复制目录、邀请两模式。
4. 修复失效文档链接（`workspace-authorization-matrix.md` 等）。
5. Agent Note 状态改为“实现补齐中、验收未完成”，移除错误现状描述。

### 第 2 批：统一管理员保护

`access/admin-policy.ts` 提供唯一入口：

- `lockAdminMutationsTx`（事务级 advisory lock）；
- `assertActiveAdminActorTx`（锁内重读操作者角色/注销/平台封禁；root
  视为系统账号）；
- `countAvailableAdminsTx` / `assertAvailableAdminRemainsTx`（排除
  root、已注销、有效平台封禁）。

降权、平台封禁、解封、后台注销、自助注销全部走同一把锁；锁顺序固定为 管理员锁 →
账号行（按 ID 排序）→ 域行（按 ID 排序）→ 成员/资源。
封禁的会话版本、旧封禁关闭、新记录与审计同事务提交；缓存失效与通知在提交后执行。

### 第 3 批：域能力与授权读取

- 删除 `StoredDomainPreset` 的 `custom` 与兼容分支；域 CHECK 收紧到三种类型。
- `effectiveDomainConfiguration()` 纯推导；写入只接受三个存储字段。
- 社区通知 SQL 从 `domainTypeConfiguration` 生成允许的 preset
  集合并叠加实例模块政策， 不再读取已删除的 `configuration.features`。
- 列表、未读数、详情、批量/单条已读、SSE 实时事件与重放共用同一可见性规则。

### 第 4 批：独立复制与来源目录

- 题目/题单复制固定“账号先于域”，多域按 ID 排序；锁外完成文件读取与上传。
- 题目复制固定已发布源版本；AI 复制只保留可移植别名与预算。
- 题单复制按源题 ID 去重，一个事务内发布题单与题目，复核源 revision。
- 新增 `copy-sources.ts`：授权过滤、关键词、计数、排序、分页全部在 SQL 完成；
  不返回答案、评测配置、文件地址或密钥。

### 第 5 批：追加迁移

1. `domain_problem_bindings` 删除 `kind` 与相关 CHECK。
2. 题目同域复合外键：`(domain_id, problem_id)` → `problems(domain_id, id)`。
3. 删除 `domain_training_bindings`、schema 导出、查询 join 与旧共享删除保护。
4. 域与创建申请 preset CHECK 收紧到三种类型。
5. 迁移前检查异常共享绑定、跨域绑定与 `custom` 数据；异常明确中止。
6. 只追加迁移，禁止手改 `_journal.json`。

### 第 6 批：迁移预检与 CLI 升级恢复

Core：

- `startup` 模式要求 ledger 与打包迁移集完全一致；
- `pre-migration` 模式允许合法前缀，但逐条比较 hash/created_at/顺序；
- 额外记录、缺中间记录、同条数漂移、未知历史、查询失败一律拒绝；
- 无 ledger 只允许真正空库；`db check-upgrade` 与实际迁移入口共用同一校验。

CLI：

- compose 参数固定 `--project-directory <安装目录>`，即使 `-f` 指向暂存文件；
- 所有发布文件先写暂存目录；顺序为：暂存校验 → 备份 → 拉取/验签 → 只读预检 →
  排空 → 提交候选文件与环境 → 迁移 → 启动/健康检查 → 退出维护 → 完成；
- 失败分支不再发布目标文件；
- checkpoint 记录候选文件摘要、暂存目录、最后阶段与 `migration_started`；
- 迁移开始前的提交失败恢复整组旧文件并退出维护；迁移开始后保留候选与备份。

### 第 7 批：前端合同

后台用户页单值角色；删除自定义角色 CRUD 页面与导航；`WorkspaceMember.role`
单值；域成员页调用单数 `/role`；用复制目录替换 `DomainSharedCatalog`；
角色/登录/域切换后刷新身份与能力缓存；SSR 测试改查保留内容并断言无随机题块。

### 第 8 批：其余删除项与保留功能

清理旧角色/共享/moment/时间窗/随机推荐/旧榜单残留；`cleanup-pre-workspace-data.ts`
不再刷新 `user_rankings`；验证签到、两类补题、域榜单、Native/WASM。

### 第 9 批：测试合同与发布等价验收

E2E 夹具统一固定角色；重写自定义 RBAC 测试为固定角色矩阵；每个场景先检查 setup；
先跑相关 Domain 再跑全量分片与受影响 E2E；使用新隔离会话或专用 runner；
Production CLI E2E 覆盖恢复后的真实业务；WASM 四个分片实际运行；执行 5.4 旅程。

## 四、验收组

| 验收组               | 完成条件                                                                            |
| -------------------- | ----------------------------------------------------------------------------------- |
| T01–T02 初始化与旧库 | 空库初始化、重复初始化、合法后续迁移；旧库/漂移/未知 ledger 在 DDL 前失败且状态不变 |
| T03–T09 授权与并发   | 角色矩阵、旧 JWT 失权、负责人限制、最后管理员保护、锁顺序，真实数据库证据           |
| T10–T13 独立复制     | 副本独立；失权/revision/文件失败回滚补偿；AI 别名与秘密边界                         |
| T14–T15 邀请         | 单次消费并发与重复接受幂等；班级邀请不绕过域准入                                    |
| T16–T20 删减与保留   | 删除接口 404 且 UI 无入口；签到、两类补题、榜单与统计可用                           |
| T21 浏览器           | 浏览器全域 24 个旅程通过（48 步）/ 0 失败                                           |
| T22 升级             | 故障矩阵全覆盖；旧库预检早于排空；挂载目录正确；半提交可恢复                        |
| T23 恢复             | 业务数据 → 备份 → 隔离恢复 → 登录 → 发布题目 → 提交 → 实际评测完成                  |
| T24 隔离模式         | Native 与 WASM 均实际运行，记录资源池与镜像摘要                                     |
| 新增回归             | 社区通知各路径一致；复制来源分页不泄漏；同域外键生效；升级中断一致性                |

## 五、门禁命令

```sh
deno run -A scripts/check-ci.ts
cd noj-core && deno task check && deno task test:domain <domain>
cd noj-core && deno task test:shared
cd noj-core && deno task test:parallel --shards 4 --jobs 2
cd noj-ui && deno task check && deno task test && deno task test:components && deno task build
cd noj-cli && deno task check && deno task test
cd noj-tests && deno task test:logic
cd noj-judge && cargo nextest run --all-targets
```

本地隔离会话：

```sh
cd noj-tests
deno task env:up --session fixed-roles-acceptance --fresh --ui
deno task test:domain identity --session fixed-roles-acceptance
deno task test:domain cross-domain --session fixed-roles-acceptance
deno task test:browser --session fixed-roles-acceptance --profile
deno task env:down --session fixed-roles-acceptance
```

## 六、当前进度（随提交更新）

分支 `refactor/fixed-roles-and-feature-simplification`，基线 `b3ece1b2`。

| 批次                           | 状态 | 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 第 1 批 基线与合同测试         | 完成 | `53e56f10`：复制来源目录合同（授权过滤、分页形状、排除自身、不返回答案）；删除的角色/权限接口 404；共享接口 404 见 `domain-resource-management.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 第 2 批 统一管理员保护         | 完成 | `ac09e750`：`assertAvailableAdminRemainsTx`/`assertActiveAdminActorTx`，并发互降与并发封禁测试；2026-11-04 补 `admin-last-admin-contract.test.ts` 钉住 409 + `code=LAST_ADMIN`（access 403 通过）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 第 3 批 域能力与授权读取       | 完成 | `ac09e750`：`effectiveDomainConfiguration` 纯推导、实例模块策略过滤、通知可见域按 preset 过滤；`0a42f06e` 授权矩阵文档                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 第 4 批 独立复制与来源目录     | 完成 | `ac09e750` 后端 `/copy-sources` 与 `copyDomainTraining`；`5630a959` 前端 `DomainCopyCatalog`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 第 5 批 追加迁移               | 完成 | `0137_flippant_firestar`：删 `kind` 与 CHECK、加同域复合外键 `domain_problem_bindings_problem_domain_fk`、删 `domain_training_bindings`、preset CHECK 收紧；迁移前 `DO $$` 检查跨域绑定与未知 preset 并中止。实测：全新库完整链通过（problems 356 / contests 126 / education 144 / evaluations 472 / read-models 80 / access 403 / communication 84）；合法新模型库带业务数据追加 0137 成功（ledger 136→137，绑定与沿革保留），跨域绑定被外键拒绝、`custom` 被 CHECK 拒绝                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 第 6 批 预检与 CLI 恢复        | 完成 | `ac09e750` ledger 双模式校验（HTTP 启动与 `db migrate` 共用同一比较器）、compose `--project-directory`、候选文件提交与回滚；`e6d3aaaa` `--recover` 复用 checkpoint 目标版本与暂存发布集；`370eea34` 迁移失败矩阵用例（候选已提交、备份保留、checkpoint failed + migration_started）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 第 7 批 前端合同               | 完成 | `5630a959`：后台单值角色、删除 `/admin/roles` 页面与入口、成员页单值 `/role`、复制目录替换共享组件；UI check/test/components 通过（422 组件测试）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 第 8 批 其余删除项与保留功能   | 完成 | 已完成：`cleanup-pre-workspace-data.ts` 不再刷新 `public.user_rankings`；生产代码残留扫描 `shared-resources`/`/sharing`/`role_ids`/`time_window`/`random-problems`/`user_rankings` 均为 0（仅注释说明拒绝语义）；签到与作业/比赛补题见 education 144、域榜单见 read-models 80、新增 `max_uses=1` 并发兑换与重复接受幂等测试（access 403）。Native/WASM 已实测：`oi-native` 池真实跑通，WASM 四分片在固定 SDK 下全部通过                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 第 9 批 测试合同与发布等价验收 | 部分 | `8d72000c`：E2E 夹具改单值角色、RBAC 重写、公告治理改平台管理员。隔离会话 `fixed-roles-acceptance`（`--fresh` 重建镜像、`JUDGE_RESOURCE_POOLS=ai,oi-native`）实测：`identity` 34/0、`catalog` 32/0、`system` 35/0、`submission` 39/0（8 ignored）、`admin` 11/0、`objective` 1/0、`community` 3/0、`contest` 27/0、`cross-domain` 56/0（含真实 OI Native 提交与 storage-failure）。会话入口补齐 `E2E_BASE_URL`/`E2E_REDIS_CONTAINER`/`E2E_CORE_CONTAINER`/`E2E_MINIO_CONTAINER` 与 `E2E_JUDGE_RESOURCE_POOLS` 注入。浏览器旅程（`--ui --fresh` 构建 + 预览服务）：`workspace` 过滤 5 通过 / 2 失败——`workspace-llm-model-governance` 第 4 步 evaluator 屏障 45s 超时（LLM gate 夹具环境），`workspace-teaching-journeys` 已修：班级邀请不得绕过域准入，夹具先由管理员把学生邀请进域，教师再发班级邀请——该旅程 1/1（6 步）通过。`workspace-llm-model-governance` 仍失败：evaluator 屏障 45s 内 arrivals=0（judge 容器无 coordinator 注入，属本地会话环境缺口）。Production CLI E2E（真实 pg_dump/pg_restore/gpg/tar 往返，容器指向会话库）：4/4 通过。待做：WASM 四片（需 CI runner 重建固定 WASI SDK）、T23 业务级恢复演练（备份→隔离恢复→登录→发布→提交→评测）、LLM 治理用例环境补齐 |

已通过的门禁（本地）：core `test:parallel --shards 4 --jobs 2` 四个分片全部通过
（0 失败，junit 记录 2392 个用例）；分域 `access` 403、`problems` 356、
`contests` 126、`education` 144、`evaluations` 472、`read-models` 80、
`communication` 84；CLI 830（4 ignored）；UI `check` / `test` 345 /
`test:components` 422 / `build`； `scripts/check-ci.ts`
全绿（含迁移安全、快照链、路由目录、静默跳过、单文件规模、
合同重导出、依赖审计）；`fmt`/`lint`（改动文件）、Markdown 链接与 Agent Note
格式检查。

### 评审整改（2026-11-04 独立评审）

独立评审（adversarial review）在 `755bc82c` 上给出 3 条 P1 与 8 条
P2，全部按实证处理：

| 发现                                                               | 处理                                                                                            | 证据                                       |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `restore_drill_contract.test.ts` 仍写已删除的 `user_roles`/`roles` | 改为 `UPDATE users SET role='admin'`；SQL 渲染抽成 `renderSeedDrillAdminSql` 纯函数并加测试锁定 | `noj-cli/src/prod/drill/drill_test.ts`     |
| 复制失败补偿/失权/源身份变化只有声称                               | 新增 `workspace-copy-failure.test.ts` 两个用例                                                  | `problems` 355/0                           |
| `LAST_ADMIN` 无状态码与错误码断言                                  | 新增 `admin-last-admin-contract.test.ts`，并发用例补 `status`/`code`                            | `access` 402/0                             |
| `account-lifecycle.ts` 保留无锁重复实现                            | 删除死代码，只保留 `lockActiveWorkspaceAccount`                                                 | 生产代码零引用                             |
| `setMemberRoles` 数组适配器残留                                    | 删除适配器，31 个测试文件改单值 `setMemberRole`                                                 | `deno check` 全量通过                      |
| 路由目录生成器漏掉模板串路径                                       | 四条域资源路由改字面量路径                                                                      | 路由目录 277 → 281                         |
| `startup` 校验模式零调用                                           | HTTP 启动与 `db migrate` 共用 `schema-compat.ts` 的 `validateMigrationLedger`                   | `schema-compat.ts` / `migration-switch.ts` |
| 治理列表返回存储态配置（缺派生字段）                               | 改为 `effectiveDomainConfiguration` 派生                                                        | `governance.ts`                            |
| LMCC 类型残留 `is_shared`、时长基线指向已删测试                    | 删除字段与基线条目                                                                              | `types.ts` / `test-duration-baseline.json` |

计数口径说明：上表与证据表中的分域数字来自本地 `deno task test:domain`
输出，含表驱动 循环，静态检索无法复现；以测试运行器输出的 `N passed | 0 failed`
为准。

CI（提交 `731c4d71`）：PR 检查 **42 成功 / 0 失败 / 6 跳过**（跳过项为
judge、LMCC 等按路径过滤的任务）；同提交 `workflow_dispatch` 全量运行覆盖全部
job，其中 `Judge WASI SDK` 与四个 `Judge WASI Acceptance` 分片全部
success，`Judge Tests` 与 `Judge Check` 亦为 success。

### 第二轮整改（2026-11-05 剩余 9 条）

第二轮独立评审复核了第一轮 9 项修复（逐条变异验证：SQL 回退、错误码改名、补偿
no-op 均能让对应用例变红），确认无 P0/P1 回归，另列出 4 条 P2
与若干工程债。按「全部执行修复」的意见，本轮关闭剩余 9 条：

| 发现                                                                | 处理                                                                                                                                        | 证据                                                                                                                                    |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 社区封禁会连带解除生效中的全站封禁（关闭活跃封禁不带 `scope` 过滤） | 关闭活跃封禁按 `scope` 过滤；`unbanUser` 仍一次性解除全部范围；封禁通知改为 best-effort                                                     | `user-ban.test.ts` 新增「社区封禁不解除平台封禁，解封解除全部」；`education` 账号政策用例改为先显式解除全站封禁再验证社区封禁不阻止教学 |
| 提交后副作用（`afterCommit`、封禁通知）抛错会让已提交请求返回 500   | 新增 `shared/base/best-effort.ts` 的 `runBestEffort`，接入账号注销（`access/account.ts`、`application/access.ts` 各两处）与社区默认频道回调 | `deno check`；账号注销与社区用例保持通过                                                                                                |
| 复制失败补偿只有独立用例，未验证 `importDomainProblem` 真的调用补偿 | `importDomainProblem` 增加 `deps: { commit?, compensate? }` 注入点，提交失败必须调用补偿并原样抛出                                          | `workspace-copy-failure.test.ts`「域导入接线：提交失败时调用补偿并原样抛出」                                                            |
| 演练契约在 CI 里「绿但没跑」                                        | `e2e-cross-domain` job 注入 `NOJ_E2E_REQUIRE_DRILL=1`：前置条件不满足直接失败，不再静默 skip                                                | `.github/workflows/e2e.yml`、`restore_drill_contract.test.ts`                                                                           |
| 路由目录生成器只认字面量路径，模板串路由逃过目录                    | 支持可解析的 `const` 模板与字面量循环，无法解析即抛错；目录重新生成                                                                         | 路由目录 281 → 386（62 个路由文件）；`gen-route-catalog_test.ts` 新增 3 个用例                                                          |
| 测试耗时基线仍指向 5 个已删除测试                                   | 删除死条目（415 → 410）；启动器逐条核对文件存在；新增基线自测并纳入 `check-ci`                                                              | `scripts/test-duration-baseline_test.ts`、`test-launcher.ts`                                                                            |
| Agent Note 仍停留在 `proposed`                                      | 移到 `.agents/notes/implemented/architecture/`，`Status: implemented`，按 implemented 规范删除 `## Plan`/`## Acceptance criteria`           | `verify-agent-note-format.ts`（601 篇）                                                                                                 |
| 静默跳过报告行号漂移                                                | 重新生成报告（命中 335 处，未超基线）                                                                                                       | `scripts/check-ci.ts` 绿                                                                                                                |
| 会话容器与预览服务残留                                              | 保留到验收结束，用 `env:down --session fixed-roles-acceptance` 清理                                                                         | —                                                                                                                                       |

## 七、验收证据表（T01–T24）

证据全部来自本分支提交，命令与环境在「证据」列注明；本地会话为
`fixed-roles-acceptance`（`--fresh`
重建镜像、`JUDGE_RESOURCE_POOLS=ai,oi-native`）。

| 验收组             | 结果 | 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T01 空库初始化     | 通过 | `deno task test:domain <domain>` 每个 domain 都在全新测试库跑完整迁移链（136→137），problems/contests/education/evaluations/read-models/access/communication 全绿                                                                                                                                                                                                                                                                                                   |
| T02 旧库与漂移     | 通过 | 探针库先迁移到 0136 → 写入域/题/版本/绑定/沿革 → 应用 0137：ledger 136→137、绑定与沿革保留；跨域绑定插入被 `domain_problem_bindings_problem_domain_fk` 拒绝、`preset='custom'` 被 CHECK 拒绝；`check-migration-safety` 与快照链门禁通过                                                                                                                                                                                                                             |
| T03–T09 授权与并发 | 通过 | core `access` 402（含 `admin-mutation-concurrency.pg.test.ts` 双连接屏障：互降权/互封禁各只成功一次，并断言 `status=409`/`code=LAST_ADMIN`；`admin-last-admin-contract.test.ts` 覆盖锁内计数与真实 `createApp()` 的 409+code 序列化）；E2E `identity` 34/0、`admin` 11/0                                                                                                                                                                                            |
| T10–T13 独立复制   | 通过 | core `problems` 355（复制来源目录合同、同域外键、副本独立；`workspace-copy-failure.test.ts` 覆盖 prepare 后失权被拒且零副本、源身份变化 409 且补偿删除本次上传对象）；E2E `cross-domain` 56/0（复制后源变更不影响副本、storage-failure 注入）                                                                                                                                                                                                                       |
| T14–T15 邀请       | 通过 | `invitation-modes.test.ts` 含 `max_uses=1` 并发兑换只成功一次、重复接受幂等、`mode=once` 400；浏览器教学旅程证明班级邀请不绕过域准入                                                                                                                                                                                                                                                                                                                                |
| T16–T20 删减与保留 | 通过 | 删除端点 404（角色/权限/共享）、生产残留扫描为 0；`education` 144（签到、作业与比赛补题）、`read-models` 80（域榜单）、`contests` 126                                                                                                                                                                                                                                                                                                                               |
| T21 浏览器         | 通过 | 浏览器全域 24 个旅程通过（48 步）/ 0 失败（`NOJ_RUN_BROWSER_E2E=1` + 预览服务）。`workspace-teaching-journeys` 1/1（6 步）：班级邀请不绕过域准入，夹具先由管理员邀请学生进域。`workspace-llm-model-governance`：会话缺陷已修——evaluator 侧协调服务地址改用容器端口 8010（此前导出宿主映射端口，评测容器连不上，`arrivals=0`）                                                                                                                                       |
| T22 升级故障矩阵   | 通过 | CLI 830：预检/排空/迁移失败、`--recover` 复用候选集、候选提交与回滚、checkpoint 阶段与摘要断言                                                                                                                                                                                                                                                                                                                                                                      |
| T23 恢复           | 通过 | Production CLI E2E 真实 `pg_dump`/`pg_restore`/`gpg`/`tar` 往返 4/4；恢复演练夹具的回退 SQL 已改为 `UPDATE users SET role='admin'`（原实现仍写已删除的 `user_roles`/`roles`，会直接失败）；会话库备份→隔离库恢复后逐表一致（domains 19、problems 27、versions 32、bindings 27、submissions 14、users 58）。应用级演练：以恢复库启动探针 core（同镜像 + 同存储卷）→ 管理员登录 → 新建并发布客观题 1008 → 交卷得分 100 → 提交代码题 1002 → 真实 Judge 返回 `finished` |
| T24 隔离模式       | 通过 | Native：`cross-domain` 的 `assignment-all-kinds` 在 `oi-native` 池下真实跑通。WASM：本地构建固定 SDK `noj-wasi-sdk-34-v2`（`sdk_sha256 b761e3a0…`，clang 23.1.0-wasi-sdk / LLVM `895aa2c8`），四分片全部 EXIT 0——`wasi`（含「拒绝读取 Worker 私有文件」负例）、`standard`（TLE 判定）、`compat`、`analysis`（分类与去重一致），运行提交 `3e5a205e`                                                                                                                  |
| 新增回归           | 通过 | 社区通知可见域按 preset 推导（communication 84 + E2E community 3/0）；复制来源分页合同；绑定同域外键；升级中断一致性用例                                                                                                                                                                                                                                                                                                                                            |
