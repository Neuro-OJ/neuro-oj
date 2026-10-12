# 工作空间模块

产品 Domain 是资源与成员权限边界，与 `src/domains/` 的源码业务分层不同。
本模块管理 Instance 政策、Domain、角色、成员、邀请和治理，不持有源题、
提交或教学业务；跨模块只通过 `index.ts` 门面访问。

## 当前交付

- 实例访问 / 注册 / 域创建政策及邀请注册限制，配置复用系统注册表。
- 公开发现与本人域列表、创建 / 申请审核、设置、状态及 Preset 差异预览 / 应用。
- 当前成员关系、固定组合角色、加入申请、负责人原子交接及邀请接受 / 撤销。
- 注册与 OAuth 新账号遵守实例政策；邀请不绕过管理员开户，不重置已有账号。
- 默认域幂等初始化；既有配置和负责人不会被启动重新覆盖。
- URL 解析上下文、事务审计、revision 前置条件及受保护的只读 / 停用状态。

完整实例模块允许列表、资源默认上限、管理 Web 界面、教学及资源全链路隔离
尚未完成。单独创建 Domain 不代表所有 OJ 资源已切换到域路由。

## 调用与授权

`loadWorkspace(slug, actorId, { executor, write, lock })` 从数据库读取当前域、
账号、成员和角色，返回 WorkspaceContext。它只证明域可进入；业务调用方必须
继续检查模块、资源归属、共享授权、班级 / 比赛关系和返回字段。

写入服务在同一事务使用传入 executor，包括平台 RBAC 查询和审计。
不能在持有事务连接时另用根连接查询权限，避免单连接测试及资源耗尽时死锁。
两个域共同参与的写入按稳定域 ID 顺序加锁，不能使用浏览器当前域或 JWT
域列表授权。

`active` 正常使用；`archived` 保留授权读取、拒绝新业务写入；`suspended`
阻断普通用户进入，平台治理须指定明确目标。成员移除通过状态保留历史，不删除账号。

## 接口

接口前缀为 `/api/v1`，具体路由以 `routes/index.ts` 为准。

| 入口                                            | 用途                         |
| ----------------------------------------------- | ---------------------------- |
| `/instance`                                     | 当前实例访问和创建政策摘要   |
| `/domains`、`/me/domains`                       | 发现、创建与本人当前空间     |
| `/domain-creation-requests`                     | 创建申请                     |
| `/admin/instance/domain-creation-requests`      | 平台审核                     |
| `/domain-invitations/accept`                    | 登录身份接受邀请             |
| `/domains/:slug`                                | 概览及带 If-Match 的配置修改 |
| 域下 `status`、`preset-preview`、`preset-apply` | 状态与模板配置               |
| 域下 `join`、`join-requests`、`members`         | 加入与当前成员治理           |
| 域下 `invitations`、`transfer`                  | 邀请和负责人交接             |

用户偏好仅用于导航。资源 ID 放入其他域路径必须重新校验该域归属，不据 ID 放行。

## 初始化与迁移

0113 创建基础表，0114 扩展合法审计动作，0115 增加 catalog 可空归属与绑定表。
扩展步骤保留旧分类与唯一键；后续回填及所有写入切换完成后才能收紧非空并移除 P/U。

服务器顺序：迁移 → root → RBAC → 默认域。源码开发的已有题库回填使用：

```sh
deno task db:migrate
deno task db:catalog-backfill
```

回填先初始化默认域，只将未归属的旧 P 题和题单归入 main，创建本域绑定与初始
策略沿革。若存在待处理 U 题则整个回填事务失败，需按用户确认的数据方案处理。
重复执行不修改已有绑定策略，题目、版本和提交 ID 不变。编号游标只增不减。

当前资源归属仍是扩展期间的可空字段。回填工具不是删除工具，不允许通过它清除
未核实的数据；开发数据清理的独立工具和授权记录见根目录实施记录。

## 验证

```sh
deno task test:domain workspace
deno task test:domain catalog
deno task check:types
```

catalog 的工作空间场景覆盖来源题号、版本同题约束、绑定策略独立、回填幂等、
实时授权及容量检查；不代表提交、附件、搜索、IDE 和教学全部入口已验收。
持续进度见根目录
[任务清单](../../../../dev-docs/superpowers/plans/2026-10-12-workspace-upgrade-tasks.md)。
