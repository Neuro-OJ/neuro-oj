# Agent Note: 固定角色与功能简化的执行跟踪

Status: proposed

## Problem

NOJ 的授权模型原先由可编辑 RBAC、角色数组与两套 access 实现组成，并且保留了
moment、训练时间窗比较、首页随机推荐、跨域共享语义与旧 Bash 部署路径。目标是把
授权收敛为固定平台角色 + 单值域成员角色 + 静态能力映射，同时删除上述功能，并让
跨域资源只产生独立副本。

2026-11-03 的第一轮实现已完成主体代码（P0–P12 的固定角色、配置去重、共享表删除、
旧榜单链路删除、CLI 预检），并推送主题分支与草稿 PR #717。2026-11-04 的全面评审
在提交 `b3ece1b2` 上发现仍有真实代码缺口，因此该记录回到 `proposed`：**实现补齐
中、验收未完成**。完整计划与固定合同见
[`dev-docs/superpowers/plans/2026-11-04-fixed-roles-feature-completion.md`](../../../../dev-docs/superpowers/plans/2026-11-04-fixed-roles-feature-completion.md)。

评审确认的缺口与当前状态（2026-11-04 补齐）：

- 管理员保护锁只接入角色变更 → **已关闭**：降权/封禁/后台注销/自助注销共用事务级
  锁，双连接屏障测试证明互降权与互封禁各只成功一次。
- 社区通知过滤读取已删除的 `configuration.features.community` → **已关闭**：可见域
  集合由 `domainTypeConfiguration` 生成并叠加实例模块政策。
- 后台用户页、创建账号对话框与域成员页仍使用 `role_ids` / 复数 `/roles` → **已关闭**：
  单值角色合同 + 删除角色 CRUD 页面与导航。
- 资源 composable 仍调用 `/shared-resources`、`/sharing`，后端缺 `/copy-sources` →
  **已关闭**：新增来源目录与 `DomainCopyCatalog`。
- 题目复制先锁域、再经创建服务锁账号 → **已关闭**：账号先于域，多域按 ID 排序。
- 升级在预检通过后失败仍发布目标文件，暂存 compose 未固定项目目录 → **已关闭**：
  候选文件排空后提交、失败整组回滚，`--project-directory` 贯穿，`--recover` 复用
  同一候选集。
- 旧库预检只统计 ledger 条数 → **已关闭**：HTTP 启动（`startup`，要求完全一致）与
  `db migrate`/`db check-upgrade`（`pre-migration`，允许合法前缀）共用
  `schema-compat.ts` 的同一个 `validateMigrationLedger`，逐条比较 hash 与时间戳。
- 绑定 schema 仍保留 `owned/shared` 与 `domain_training_bindings`，`custom` 兼容 →
  **已关闭**：迁移 0137 删除 `kind`、建立同域复合外键、删除题单绑定表、收紧 preset
  CHECK，并对异常数据中止。

2026-11-04 独立评审（adversarial review）在 `755bc82c` 上又发现三类问题，均已关闭：

- 恢复演练夹具仍写已删除的 `user_roles`/`roles` → **已关闭**：改为
  `UPDATE users SET role='admin'`，并把 SQL 渲染抽成 `renderSeedDrillAdminSql`
  纯函数加测试锁定，避免与 `drill.ts` 再次分叉。
- 「失权 / 源身份变化 / 文件失败补偿」只有声称没有断言 → **已关闭**：新增
  `workspace-copy-failure.test.ts`（prepare 后撤销目标域发布权限 → 提交被拒且零副本；
  源身份变化 → 409 且补偿删除本次上传对象）。
- `LAST_ADMIN` 只在实现与文案层面被引用 → **已关闭**：新增
  `admin-last-admin-contract.test.ts` 钉住 409 + `code=LAST_ADMIN` 与真实
  `createApp()` 的 HTTP 序列化，并发用例同时断言 `status`/`code`。
- 死代码与门禁盲区 → **已关闭**：删除 `account-lifecycle.ts` 中无锁重复实现与
  `setMemberRoles` 数组适配器（全部调用点改单值）；路由目录生成器此前漏掉模板串
  路径，四条域资源路由改为字面量路径后进入目录（277 → 281）。

此前记录的“仍待完成”三项也已关闭：WASM 四分片用固定 SDK `noj-wasi-sdk-34-v2`
本地与 CI 全部通过；T23 完成备份→隔离恢复→登录→发布→提交→真实评测；LLM 治理
浏览器用例的 coordinator 地址改回容器端口 8010。

仍待完成（**存量问题，本次重构未引入**）：封禁关闭活跃记录时未按 `scope` 过滤；
封禁/注销在提交后仍有可抛出的通知副作用（可能“已生效却返回 500”）。逐项证据见计划
文件第七节「验收证据表」。

## Decision

按批次补齐，不重做主体实现：

1. 先建立准确基线与合同测试，再把计划落到仓库内文档。
2. 降权、封禁、解封、后台注销、自助注销共用一把事务级管理员锁，锁顺序固定为
   管理员锁 → 账号行 → 域行 → 成员/资源；封禁的会话版本、旧封禁关闭、新记录与审计
   同事务提交。
3. 域能力只由类型推导；SQL 需要的 preset 集合从同一份 `domainTypeConfiguration`
   生成并叠加实例模块政策，不再读取存储的派生能力。
4. 复制固定“账号先于域”，题单复制在单事务内发布题单与题目；新增来源目录在 SQL 内
   完成授权过滤、计数、排序与分页。
5. 迁移只追加：删除绑定 `kind`、建立同域复合外键、删除 `domain_training_bindings`、
   收紧 preset CHECK，异常数据明确中止。
6. 迁移预检分离 `startup`（完全一致）与 `pre-migration`（合法前缀逐条校验）两种模式。
7. CLI 升级固定 `--project-directory`，候选文件在排空后、迁移前提交，失败分支不再
   发布目标文件；checkpoint 记录候选摘要与 `migration_started`。
8. 前端完成单值角色合同与复制目录替换，SSR 断言改为保留内容并断言无随机题块。
9. E2E 夹具统一固定角色，最终在发布等价环境跑完整门禁与真实旅程。

## Alternatives considered

- **保留旧授权兼容层**：会让两套口径继续漂移，且与“只支持新模型数据库”的已确认
  决定冲突，不采纳。
- **只补人工验收记录**：评审发现的失败是真实行为缺陷（社区通知、升级状态机、锁顺序），
  记录无法替代修复，不采纳。
- **为删除端点建兼容转发**：会让旧前端继续工作，但违反“删除接口返回 404”的合同，
  不采纳。
- **在应用层用进程内 mutex 保护最后管理员**：多副本下无效，必须使用数据库事务级锁，
  不采纳。

## Consequences

- 管理员集合的所有写入口串行化，吞吐下降但换取最后管理员保护的可证明性。
- 域配置不再存派生能力，读取路径必须每次推导；旧 `custom` 行需要人工处理，
  迁移遇到异常会中止而不是猜测转换。
- 复制来源目录多一次授权过滤查询，但分页不会泄漏未授权来源。
- 升级状态机更严格：失败后可能停在“未完成”状态并要求 `--recover`，不会误报成功。

## Plan

按 `dev-docs/superpowers/plans/2026-11-04-fixed-roles-feature-completion.md` 的
第 1–9 批顺序执行，每批单独形成签名提交，前一批关键验收通过后再进入下一批。

## Acceptance criteria

T01–T24 与真实操作旅程逐项具备可核查证据（提交、命令、环境、结果位置）；同一最终
提交的必要 CI 全部通过；核心验收不得以 skipped 通过。详细矩阵见计划文件第四节。
