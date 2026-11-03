# Agent Note: 固定角色与功能简化的执行跟踪

Status: proposed

## Problem

`/home/sakura-madoromi/.cache/noj-plan.md` 要求把 NOJ 的授权模型从可编辑 RBAC、
角色数组与两套 access 实现，收敛为固定平台角色 + 单值域成员角色 + 静态能力映射，
同时删除 moment、训练时间窗比较、首页随机推荐、跨域共享语义与旧 Bash 部署路径。
该变更跨 core / ui / cli / docs，包含 schema 迁移与旧库拦截，不能在一个提交或一次
会话内完成，需要可持续跟踪的执行记录。

本地事实（2026-11-03）：

- 工作副本父提交 `45b50891`（rc/v0.11）；`main` 为 `ad0e564b`，**不包含**
  rc/v0.11 基线，按计划 P0 需要独立 PR 完成 RC 集成后才能从 main 派生正式主题分支。
- 本执行先在该基线上的 jj 工作副本继续，主题 bookmark 为
  `refactor/fixed-roles-and-feature-simplification`；RC 集成 PR 是发布前置条件，
  不是本记录可以声称完成的部分。
- GPG 私钥与 `jj` 签名配置可用（`signing.behavior=own`）。
- 测试基础设施：`noj-e2e-postgres`（`e2e/e2e@127.0.0.1:5433`）、
  `noj-e2e-redis`（6380）、`noj-e2e-minio`（9002）容器在运行，可作为
  `deno task test:domain` / `test:shared` 的隔离资源；正式门禁仍需按计划 4.3
  逐项执行。

## Decision

以 `/home/sakura-madoromi/.cache/noj-plan.md` 为唯一实施依据，按 P0–P12 顺序执行，
同一时刻只推进一个写入面（用户要求：不启用 subagent，按顺序自行执行）：

1. P0 基线与分支；P1 合同冻结。
2. P2 固定角色与静态能力映射（`noj-core/src/shared/access/roles.ts` 为唯一事实源）。
3. P3 schema、迁移与旧库双层拦截。
4. P4 认证与平台管理员；P5 域授权与成员生命周期统一；P6 初始化、种子与夹具。
5. P7 域配置去重；P8 跨域资源收敛为独立复制。
6. P9 moment / 时间窗 / 随机推荐删除；P10 邀请模式合并；P11 旧榜单与前端空壳。
7. P12 CLI 旧库预检与旧 Bash 清理；最后补文档、Agent Note 与全量验收。

执行约定：

- 数据库只存 `users.role`、`domain_memberships.role`、`domains.owner_id`；
  owner 不写入成员角色列，平台管理员不伪造成域成员。
- 能力集合是只读代码映射；未知能力不能因平台管理员通配被接受。
- 迁移只追加、不重建历史；旧业务库在迁移锁内被明确拒绝，不做静默降级。
- 测试按 `deno task test:domain <domain>` / `test:shared` / `test:parallel`
  执行，不用静态检查冒充实测。

## 执行跟踪

状态：`待办` / `进行中` / `完成` / `阻塞`。

| 阶段 | 内容 | 状态 | 关键产物与验证 |
| --- | --- | --- | --- |
| P0 | 基线、分支、签名检查 | 进行中 | 主题 bookmark 已建；RC 集成 PR 未完成（发布前置） |
| P1 | 冻结对外合同 | 待办 | 端点/DTO/错误语义清单，前后端共用 |
| P2 | 固定角色与静态能力映射 | 完成 | `shared/access/roles.ts` + `tests/shared/access-roles.test.ts`（10 项表驱动断言通过） |
| P3 | schema、迁移、旧库拦截 | 进行中 | 迁移 `0132_eager_gamma_corps` 已生成并通过空库验证；迁移锁内旧库门禁 + SQL 数据保护已实现并实测拒绝旧库；RBAC/板块授权等表删除与约束下线待办 |
| P4 | 认证与平台管理员 | 进行中 | 认证中间件与权限解析改读 `users.role`；角色 PATCH 单值化；用户 DTO 带 role/is_admin；注册/OAuth 固定 user；旧 token 伪造 admin 展示角色不影响实际权限（测试覆盖）；封禁/注销共用管理员锁待接 |
| P5 | 域授权与成员生命周期 | 进行中 | 域策略单角色化；成员角色 PUT 单值；交接保持双方 admin；HTTP 路由改显式 Actor；workspace 重复实现已删（成员/域/邀请/注册），仅保留测试向适配层 |
| P6 | 初始化、种子与夹具 | 进行中 | RBAC 种子服务已删除；root/first-admin/管理员开号/CLI 演练直接写 users.role；测试 helper 已迁移，测试用例适配未完 |
| P7 | 域配置去重 | 待办 | Stored/Effective 配置分离；features/homepage 不可编辑 |
| P8 | 跨域独立复制 | 待办 | problem-copy / training-copy / copy-sources；删共享 |
| P9 | 删除 moment、时间窗、随机推荐 | 进行中 | 板块自定义角色授权（服务/端点/审计动作）已删除；moment 与随机推荐待处理 |
| P10 | 邀请模式合并 | 待办 | email/general；once 由 max_uses=1 表达 |
| P11 | 旧榜单与前端空壳 | 待办 | 删 refreshRankingsView；useAsyncData 直用 |
| P12 | CLI 旧库预检与 Bash 清理 | 待办 | `db check-upgrade`、删 deploy/*.sh |
| 验收 | 计划 4.2 T01–T24 与 5.4 人工旅程 | 待办 | 逐项证据；未验收项必须显式标注 |

已确认的阶段性事实：

- 2026-11-03：`jj status` 干净，工作副本为空提交，父提交为 `45b50891`。
- 2026-11-03：`main` 不包含 `45b50891`（`git merge-base --is-ancestor` 为否），
  因此发布前必须先完成 RC 集成，本记录不把该步骤当作已完成。
- 2026-11-03：新增 `noj-core/src/shared/access/roles.ts`，定义
  `PlatformRole`、`DomainMemberRole`、`DomainRole`、运行时校验与静态能力映射；
  创建者/共享/动态类旧能力列为过渡名且永不被授予，等待对应代码路径删除；
  `admin:full_access` 改为只授予平台 admin 的静态标识能力，域角色永不持有。
- 2026-11-03：权限解析全部改读 `users.role`（无 RBAC 递归 CTE）；认证中间件把
  数据库角色写入请求上下文，JWT role 仅作客户端展示。角色变更接口改为
  `PATCH /admin/identity/users/:id/role {role}`，实际写入在
  `access/admin-policy.ts` 的事务级管理员锁内完成，返回真实 from/to 审计。
- 2026-11-03：成员写入改为 `setMemberRoleTx` 单值；加入与恢复只恢复 member；
  负责人交接在同一事务内把新旧负责人基础角色提升为 admin；角色/移除管理保留
  “仅负责人或平台管理员可管理管理员”边界。
- 2026-11-03：访问域路由改用 `access/policy.ts` 的显式 Actor 入口，读路径构造
  Guest/User Actor；`workspace/services` 中 members/domains/invitations 的重复
  实现尚未删除，仍是下一轮 P5 的收尾项。
- 2026-11-03（第二轮）：删除 `workspace/services/{members,domains,invitations,registration}.ts`
  四份重复实现；默认域初始化改为显式 `SystemActor`（新增 `ensureDefaultWorkspaceOn`）；
  跨模块域审计走 `workspaceAudit` 适配器（内部构造 UserActor 后委托
  `workspaceAuditTx`）；教育 SQL、通知与题库共享收权改读
  `domain_memberships.role`。`workspace/index.ts` 只保留测试向 slug-first 适配层。
- 2026-11-03（第二轮）：删除 `seed-rbac.ts` 与 RBAC 种子调用；管理员开号、首次
  管理员初始化、`bootstrap admin`、CLI 恢复演练均单值写 `users.role`；
  删除已无意义的 RBAC 测试（rbac.test.ts、seed-rbac.test.ts）并把 legal 管理
  用例改为平台 admin 账号。
- 2026-11-03（第二轮）：删除板块自定义角色授权：服务函数、三个管理端点、
  `canPostToBoard` 授权分支与审计动作；数据库表删除留待迁移。
- 2026-11-03（第三轮）：生成迁移 `0132_eager_gamma_corps`（users.role /
  domain_memberships.role + CHECK + 审计动作清单），并新增
  `shared/db/migration-switch.ts`：迁移锁内、migrator 之前判断 ledger 与业务表，
  旧库一律拒绝；迁移 SQL 最前部再对 users/domains/domain_memberships 的非空数据
  做事务内保护。实测三种情形：空库 ALLOWED；ledger 落后于切换迁移 REJECTED；
  有业务表但缺 ledger REJECTED，SQL 保护在破坏性 DDL 前回滚。
- 2026-11-03（第三轮）：access 域测试完成迁移并通过——
  `deno task test:domain access` 结果为 396 passed / 0 failed；覆盖角色单值写入、
  旧 token 展示角色无效、最后管理员保护、成员角色/负责人交接、板块授权接口移除。
- 验证（2026-11-03 第二轮）：生产源码 `deno check` 0 错误；改动文件
  `deno fmt`/`deno lint` 通过；核心测试夹具（default/versioning/education/
  community）已迁移到单值角色。测试用例仍有 workspace 适配层签名差异与
  editor 语义残留，`deno task test:domain access` 尚未通过，不声称测试验收。

## Alternatives considered

- 继续保留 RBAC 表并只在前端隐藏：违反“授权事实唯一”、无法阻止 API 直接越权，
  且计划明确要求删除。
- 为旧库做逐角色转换迁移：计划 1.2 明确本版本只支持全新初始化，转换会制造
  “默认值悄悄降级授权”的风险。
- 先做 UI/CLI 并行清理、core 后补：会产生长时间不可类型检查的跨模块中间态，
  与顺序执行要求冲突，因此改回按 P0–P12 单线推进。
- 把计划拆成多个 PR 分别发布：前两个单元（角色、认证/域生命周期）属协调变更，
  计划 5.2 要求整体完成才可发布。

## Consequences

本记录保持 `proposed`，每次推进后更新“执行跟踪”表与阶段事实；全部阶段与验收
完成后，改写为 `implemented` 并迁入 `.agents/notes/implemented/architecture/`，
届时删除执行清单，只保留问题、决策、取舍与后果。任何旧库静默转换、撤权后仍获旧
权限、复制仍依赖源域、签到/补题/WASM 回归失败，均按计划 5.5 阻断发布。
