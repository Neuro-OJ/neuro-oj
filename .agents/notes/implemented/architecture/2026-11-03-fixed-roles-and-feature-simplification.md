# Agent Note: 固定角色与功能简化的执行跟踪

Status: implemented

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
| P0 | 基线、分支、签名检查 | 完成 | 主题 bookmark 已推送；RC 集成草稿 PR #717（base rc/v0.11）已创建；合并与发布仍需人工评审 |
| P1 | 冻结对外合同 | 待办 | 端点/DTO/错误语义清单，前后端共用 |
| P2 | 固定角色与静态能力映射 | 完成 | `shared/access/roles.ts` + `tests/shared/access-roles.test.ts`（10 项表驱动断言通过） |
| P3 | schema、迁移、旧库拦截 | 完成 | 迁移 `0132`（角色列 + 审计动作）与 `0133`（显式依赖顺序删除 roles/permissions/role_permissions/user_roles/domain_member_roles/community_board_role_grants，不用 CASCADE）；旧库门禁 + SQL 数据保护实测三态符合预期 |
| P4 | 认证与平台管理员 | 完成 | 认证/权限改读 `users.role`；角色 PATCH 单值；DTO 带 role/is_admin；注册/OAuth 固定 user；封禁/注销/降权共用 `lockAdminMutationsTx` 与 LAST_ADMIN 守卫；identity/access 全绿 |
| P5 | 域授权与成员生命周期 | 完成 | 域策略单角色；成员角色 PUT 单值；交接双方 admin；workspace 重复实现删除；创建者特权移除，题目/题单统一 `*_any`；access 396 全绿 |
| P6 | 初始化、种子与夹具 | 完成 | RBAC 种子服务已删除；夹具迁移到单值角色；access 396、identity 396、problems 353、contests 126、communication 84、platform 254、read-models 80、education 144、evaluations 472、shared 457 全绿 |
| P7 | 域配置去重 | 完成 | schema 列改为 Stored；写入仅三键；读取统一 `effectiveDomainConfiguration` 并叠加实例模块策略；PATCH 带 features/homepage 仍 400；access 396 全绿 |
| P8 | 跨域只复制、删除共享 | 完成 | 共享服务/表/原生 SQL/夹具全部删除；迁移 0135/0136 删四张共享表；problems 351、read-models 80、contests 126、communication 84、education 144 全绿 |
| P9 | 删除 moment、时间窗、随机推荐 | 已完成 | 后端、UI、管理配置、举报标签、BFF mock 与 noj-docs 用户文档全部移除 moment；训练比较与随机三题已删 |
| P10 | 邀请模式合并 | 已完成 | 后端仅 email/general，once→400；迁移 0134 收紧 CHECK；UI 模式类型/标签/按钮/加入页分支全部移除 |
| P11 | 旧榜单与前端空壳 | 完成 | 旧视图刷新/检查/标记全删；前端直用 useAsyncData，UI 单测 345 通过 |
| P12 | CLI 旧库预检与 Bash 清理 | 完成 | 旧 Bash 与闸门引用已清；Core `db check-upgrade` + CLI 排空前预检；发布文件暂存后切换；CLI 826/528、UI 345/422、核心域与 shared 全绿 |
| 验收 | 计划 4.2 T01–T24 与 5.4 人工旅程 | 部分完成 | 自动化证据：core access 396 / identity 396 / evaluations 472 / education 144 / communication 84 / problems 351 / contests 126 / platform 254 / read-models 80 / application 13 / assets 37 / http 37 / shared 457；UI 345 + components 422 + check + build；CLI 826 + production 528 + check；noj-tests logic 60；judge 656（46 skipped，含 Native/WASM 单元与契约）。T22 由 CLI 预检/暂存测试覆盖，T24 由 judge 套件覆盖；T23 恢复演练、T21 真实浏览器多身份切换、5.4 人工旅程仍未执行 |

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
- 2026-11-03（第四轮）：生成 `0133_spotty_the_order` 删除 RBAC 与板块授权表，按依赖顺序去掉
  `CASCADE`；同步删除权限定义文件、审计动作与后台筛选选项，全仓测试与生产代码不再引用这些表。
- 2026-11-03（第四轮）：删除创建者特权判定。题目/题单管理统一要求域
  `problem:write_any`/`training:write_any`；客观题答案只对 `access.mode === "admin"`
  或实时域权限开放，`owner` 只读模式不再解锁答案。
- 2026-11-03（第八轮）：P9/P10 UI 收尾——社区首页/详情/类型、个人主页、管理端社区配置、
  举报标签与 BFF 测试 mock 移除全部 moment；邀请管理移除 once 按钮、分支、标签与加入页展示。
  PATCH 域配置对 features/homepage 一律 400 `DOMAIN_TYPE_FIXED`。
- 2026-11-03（第七轮）：请求级权限恢复为"仅平台角色"，删除 main 域能力合并——域成员不再
  通过 `assertPermission` 获得 `training:write_any` 等平台能力（修复普通用户可 PATCH
  管理端题单的越权）；域内判定继续由 workspace access 显式完成。题库绑定读取强制
  `kind=owned`，共享绑定在管理路径返回 400 `DOMAIN_SHARING_DISABLED`。
- 2026-11-03（第六轮）：移除跨域共享列表端点与应用层题目共享命令，P8 开头；
  训练共享仍复用旧实现，后续迁到独立复制服务后删除。
- 2026-11-03（第五轮）：生成迁移 `0134_narrow_dazzler`：社区帖子类型/上下文 CHECK 收紧为
  solution/discussion，邀请 mode CHECK 收紧为 email/general。删除 moment 的服务、配置、
  个人页聚合与搜索统计分支；删除训练比较服务/路由/导出及前端组件、工具、调用；删除首页
  随机三题 BFF 段与组件。邀请后端拒绝 once，一次性由通用邀请 max_uses=1 表达。
- 2026-11-03（第四轮）：请求级能力解析合并 main 域有效角色（社区治理、题单、竞赛查重等
  旧守卫不再只认平台角色）；域级服务仍走显式 workspace 判定，避免把默认域能力当跨域授权。
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
