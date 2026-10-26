# Agent Note: 移除 P/U 题库分类

Status: implemented

## Problem

工作空间题号与授权已使用 Domain 和绑定，数据库仍保留 problems.type、P 题公开
约束、旧分类唯一索引及 create_p 平台权限。旧比赛题目列表也仍拼接分类前缀。
这些残留阻碍私有域题库统一建模，类型副本和数据库夹具容易继续依赖旧分类。

## Decision

移除 P/U Schema 字段、约束、旧索引与 create_p 权限种子。追加生成迁移
`0134_naive_johnny_blaze.sql`，先检查尚未归域的旧 U 数据，拒绝隐式转换或删除；
随后解除旧生成搜索列对 type 的依赖，按数字题号重建生成列及 GIN 索引，并移除
已退役权限关联。原题目、版本和提交 ID 不改写。

运行期默认域回填不再读取不存在的分类字段；旧 U 检查前移至收缩迁移。
比赛列表本域显示数字，跨域引用显示来源 slug:number。同步 CLI 类型副本和 PGlite
DDL，测试输入移除分类字段，格式 1 P 转换及 U 拒绝契约仍保留。

本批只收缩分类；Domain / binding 非空约束、旧入口剩余代码和整体客户端验收
继续在任务清单跟踪，不把本批当作阶段 2 完成。

## Alternatives considered

- 保留 type 作为隐藏兼容字段：继续引入分类分支，拒绝。
- DROP COLUMN CASCADE：可能掩盖其他依赖，选择显式拆除已核实的生成列与索引。
- 通过重建开发库验证迁移：不能证明存量升级，使用现有隔离恢复库实际升级。

## Consequences

Schema parity 107 表 / 971 列及迁移安全检查通过。全 core 类型检查通过。 标准
PostgreSQL catalog 364、objective 66、admin 16 项均通过；CLI 标准测试 755
项通过、4 项忽略。相关日志位于 `/tmp/noj-root-*-pu-0134.log` 和
`/tmp/noj-root-admin-policy-0134.log`。

隔离恢复库 `noj_upgrade_restore_20261012` 从已有扩展迁移升级到 0134 成功， 3
道既有 P 题保留原 UUID 和 1001–1003 题号，22 账号及 3 个版本保留，type 列
已移除。该库原来没有普通提交，不能据此声称已验证有历史提交的存量升级。 日志
`/tmp/noj-root-restore-pu-0134.log`。

另将清理前原备份恢复到 `noj_upgrade_u_guard_20261013`，标准迁移在发现旧 U 时
按预期拒绝，整批回滚；13 道原题（其中 10 道 U）保留，未执行清除或转换。 日志
`/tmp/noj-root-original-u-guard-0134-final.log`。正式开发库本批未迁移。
