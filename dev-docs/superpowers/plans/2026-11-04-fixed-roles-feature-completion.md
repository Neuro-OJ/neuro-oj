# 权限与功能简化：全面评审及补齐实施计划

> 基线：PR #717（https://github.com/Neuro-OJ/neuro-oj/pull/717），提交
> `b3ece1b28f690d40781b871e0a5979a20404664f`，base `rc/v0.11`。
> 本文件是仓库内的稳定实施记录；Agent Note 与验收证据都链接到这里，不再引用
> 用户缓存路径。

## 一、评审结论

固定角色、独立复制、功能删除的主体实现已经存在，可以继续补齐，不需要推倒重做。
但当前实现**尚不满足合并条件**，剩余工作包含真实代码缺口：

| 优先级 | 发现 | 处理结论 |
| --- | --- | --- |
| P1 | 管理员保护锁只接入角色变更；封禁分步写库、管理员注销用另一套行锁、自助注销没有最后管理员守卫 | 统一事务与锁顺序 |
| P1 | 社区通知过滤仍读 `configuration.features.community` | 由域类型 + 实例政策推导 |
| P1 | 后台用户页/创建账号/域成员页仍用 `role_ids` 与复数 `/roles` | 完成单值角色前端合同 |
| P1 | 资源 composable 仍调 `/shared-resources`、`/sharing`，后端缺 `/copy-sources` | 补来源目录并替换旧共享 UI |
| P1 | 题目复制先锁域、再经创建服务锁账号 | 固定“账号先于域”，真实 PG 双连接验证 |
| P1 | 升级在预检通过后失败仍发布目标文件；暂存 compose 未固定项目目录 | 修复升级状态机与恢复 |
| P1 | 旧库预检只数 ledger 条数，未校验完整前缀 | 迁移前逐条校验 hash/时间戳/顺序 |
| P2 | 绑定 schema 仍有 owned/shared 与 `domain_training_bindings` | 收敛到数据库约束与统一模型 |
| P2 | `StoredDomainPreset` 仍保留 `custom` 兼容分支 | 只保留三种固定域类型 |
| P2 | E2E 夹具仍创建自定义 RBAC、调用 `/roles`；SSR 断言仍要求已删除随机题块 | 更新验收合同 |
| P2 | Agent Note 状态与证据口径不准确 | 重建按提交/场景/环境归属的证据 |

## 二、固定对外合同

| 对象 | 合同 |
| --- | --- |
| 平台角色修改 | `PATCH /api/v1/admin/identity/users/:id/role`，请求 `{role:"user"|"admin"}` |
| 域成员角色修改 | `PUT /api/v1/domains/:slug/members/:userId/role`，请求 `{role:"member"|"educator"|"admin"}` |
| 负责人交接 | `POST /domains/:slug/transfer`；普通角色赋值不能获得 owner |
| 用户/成员 DTO | 单值 `role`；`is_admin` 仅为派生展示字段 |
| 域配置 | 只存 `access/discoverable/join_policy`；有效 `features/homepage` 由类型与实例政策推导 |
| 复制来源目录 | `GET /api/v1/domains/:slug/copy-sources?kind=problem|training&page&limit&source_slug&keyword` |
| 题目复制 | `POST /domains/:slug/problem-bindings`，请求 `source_ref`、可选 `version_id` |
| 题单复制 | `POST /domains/:slug/training-bindings`，请求 `training_id`；行为是独立复制 |
| 邀请 | 只接受 `email`/`general`；单次邀请使用 `general + max_uses=1` |
| 删除接口 | 角色/权限 CRUD、板块角色授权、共享设置、旧共享目录与训练时间窗接口返回 404，不建兼容转发 |

错误语义：非法角色、数组角色、普通赋值 owner、`mode=once` → 400；权限不足 → 403；
按既有隐藏规则不可见 → 404；revision、负责人状态、最后管理员冲突 → 409，其中
最后管理员使用稳定错误码 `LAST_ADMIN`。

## 三、实施批次

### 第 1 批：基线与合同测试

1. jj 工作副本、bookmark、PR head 与基线一致，GPG 可用。
2. 本文件入库；Agent Note 链接本文件。
3. 合同测试：平台单角色、域单角色、有效 owner、删除端点、配置三键、复制目录、邀请两模式。
4. 修复失效文档链接（`workspace-authorization-matrix.md` 等）。
5. Agent Note 状态改为“实现补齐中、验收未完成”，移除错误现状描述。

### 第 2 批：统一管理员保护

`access/admin-policy.ts` 提供唯一入口：

- `lockAdminMutationsTx`（事务级 advisory lock）；
- `assertActiveAdminActorTx`（锁内重读操作者角色/注销/平台封禁；root 视为系统账号）；
- `countAvailableAdminsTx` / `assertAvailableAdminRemainsTx`（排除 root、已注销、有效平台封禁）。

降权、平台封禁、解封、后台注销、自助注销全部走同一把锁；锁顺序固定为
管理员锁 → 账号行（按 ID 排序）→ 域行（按 ID 排序）→ 成员/资源。
封禁的会话版本、旧封禁关闭、新记录与审计同事务提交；缓存失效与通知在提交后执行。

### 第 3 批：域能力与授权读取

- 删除 `StoredDomainPreset` 的 `custom` 与兼容分支；域 CHECK 收紧到三种类型。
- `effectiveDomainConfiguration()` 纯推导；写入只接受三个存储字段。
- 社区通知 SQL 从 `domainTypeConfiguration` 生成允许的 preset 集合并叠加实例模块政策，
  不再读取已删除的 `configuration.features`。
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

| 验收组 | 完成条件 |
| --- | --- |
| T01–T02 初始化与旧库 | 空库初始化、重复初始化、合法后续迁移；旧库/漂移/未知 ledger 在 DDL 前失败且状态不变 |
| T03–T09 授权与并发 | 角色矩阵、旧 JWT 失权、负责人限制、最后管理员保护、锁顺序，真实数据库证据 |
| T10–T13 独立复制 | 副本独立；失权/revision/文件失败回滚补偿；AI 别名与秘密边界 |
| T14–T15 邀请 | 单次消费并发与重复接受幂等；班级邀请不绕过域准入 |
| T16–T20 删减与保留 | 删除接口 404 且 UI 无入口；签到、两类补题、榜单与统计可用 |
| T21 浏览器 | 多身份多域、提降权、交接、复制、迟到响应、登录退出 |
| T22 升级 | 故障矩阵全覆盖；旧库预检早于排空；挂载目录正确；半提交可恢复 |
| T23 恢复 | 业务数据 → 备份 → 隔离恢复 → 登录 → 发布题目 → 提交 → 实际评测完成 |
| T24 隔离模式 | Native 与 WASM 均实际运行，记录资源池与镜像摘要 |
| 新增回归 | 社区通知各路径一致；复制来源分页不泄漏；同域外键生效；升级中断一致性 |

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
