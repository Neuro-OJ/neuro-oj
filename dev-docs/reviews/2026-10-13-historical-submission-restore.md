# 历史普通提交恢复与域归属回填验证

日期：2026-10-13。验证使用独立数据库 `noj_upgrade_history_restore_20261013`，
不操作原开发库或生产库。

## 备份与历史夹具

恢复来源为 `/tmp/noj-before-domain-upgrade-2026-10-12.dump`，SHA-256：

```text
d957a7a11f02979b88b396c9d5710e1f99e39a5a9e6b05d22c99da846fa62bd8
```

备份包含 13 道题（10 道 U、3 道 P）、5 场旧开发比赛、22 个账号，普通提交为 0。
因此本次在恢复后的旧 Schema 中补入一份明确标记的普通提交与正式评测尝试，
测试历史保留；这不是原开发库中真实存在的学生提交。

| 内容         | 迁移前依据                                      | 迁移与回填后                 |
| ------------ | ----------------------------------------------- | ---------------------------- |
| 提交 ID      | `restore-proof-submission-20261013`             | 保留                         |
| 源题 ID      | `4c97a041-3b68-4c49-9805-1781e42b16da`（P1001） | 保留，默认域数字 1001        |
| 原代码       | `print("historical submission preserved")`      | 字节保留                     |
| 受理时间     | `2026-10-01T12:00:00.000Z`                      | 保留                         |
| 提交时版本   | null，`legacy_unknown`                          | 保留，不虚构版本             |
| 尝试 ID      | `restore-proof-attempt-20261013`                | 保留                         |
| 正式成绩     | accepted、10000（分值 ×100）                    | 保留                         |
| 原始输出     | `historical evaluation output`                  | 保留在库中                   |
| 原始详情     | `{"proof":"original bytes"}`                    | 保留在库中                   |
| 使用域与绑定 | 旧 Schema 不存在                                | 回填为 main 及其真实本域绑定 |

## 执行过程与结果

使用 `pg_restore --no-owner --no-privileges` 恢复独立副本。按照用户已批准的
开发数据清理政策，执行仓库清理脚本，校验上述备份哈希和准确的 U / 比赛数量，
只清除副本中的 U 相关记录及旧比赛。保留 3 道 P 题、22 个账号及新增的普通提交。

通过标准 `deno task db:migrate` 执行全部迁移至 0136，再调用公开
`backfillExecutionWorkspaces()`。回填汇总为普通提交 1 条、incomplete 0；其余
执行类别 0 条。再次调用得到相同结果，未创建重复绑定或修改原始提交。

通过本人历史服务读取该记录，返回原代码、原受理时间、null 提交时版本、main 归属及
accepted / 10000 摘要。隐藏数据与原始输出没有进入本人历史 DTO。

运行日志：

- `/tmp/noj-root-history-original-restore.log`
- `/tmp/noj-root-history-cleanup-20261013.log`
- `/tmp/noj-root-history-migrate-0136-20261013.log`
- `/tmp/noj-root-history-backfill-0136-20261013.log`
- `/tmp/noj-root-history-own-read-0136-20261013.log`

## 0137 执行归属收缩复验

同一隔离恢复库通过标准 `deno task db:migrate` 追加 0137。数据库实际列检查确认
普通提交、客观提交、自测的域与绑定，以及批量任务和条目的域均为 NOT NULL。
任务条目的绑定继续允许失败／跳过记录为空，其余状态由 CHECK 拒绝。

原普通提交的稳定 ID、代码、受理时间、未知提交时版本、正式尝试 ID、10000／AC、
原始输出和详情均保留。再次通过本人历史服务读取，得到原代码及成绩摘要，原始
评测输出和详情未进入 DTO。

- `/tmp/noj-root-history-migrate-0137-20261013.log`
- `/tmp/noj-root-history-0137-retained-20261013.log`
- `/tmp/noj-root-history-own-read-0137-20261013.log`

## 完整成绩投影的独立复验

另建 `noj_upgrade_history_complete_20261013`，从同一原备份重新恢复，等待
`pg_restore` 正常退出后才写入合成夹具。原备份没有普通提交，因而仍明确使用
合成记录；本轮同时建立旧 Schema 下真实的未知版本桶当前判定与三个成绩指针，
补齐前一轮仅验证原提交和评测尝试内容的证据。

按原授权清理准确的 10 道 U 题及 5 场比赛，保留 3 道 P 题、22 个账号和合成
提交。标准迁移一次升级到 0137，再持题目锁调用公开门面
`recomputeProblemBindingProjections()` 重建三个源题的成绩投影。

实际断言原代码、受理时间、未知版本、尝试、分版本桶 ID 与指针均未变化；
投影和本人历史 DTO 的 `is_valid`、`is_accepted` 均为 true，分值仍为 10000。
原始输出与详情留在尝试中，未进入 DTO。运行进程均退出 0。

- `/tmp/noj-root-history-complete-original-restore-20261013.log`
- `/tmp/noj-root-history-complete-cleanup-20261013.log`
- `/tmp/noj-root-history-complete-migrate-0137-20261013.log`
- `/tmp/noj-root-history-complete-projection-read-0137-20261013.log`

## 验收边界

完整历史依据恢复库又通过标准迁移追加 0138 和 0139。原开发库五场比赛已依授权
清理，未引入旧赛制兼容。0139 将两块原始板块按已知单域历史补入 main： 扩展迁移
0130 执行时 main 可能尚未初始化，留下的 NULL 现在收缩为非空。 原板块 ID 和 slug
保留。迁移日志： `/tmp/noj-root-history-complete-migrate-0138-20261013.log`、
`/tmp/noj-root-history-complete-migrate-0139-20261013.log`。

另有两库自动回归实际执行 0139 SQL，覆盖旧题解／评论／举报／通知由真实父关系
回填，以及原正文、真实题库绑定和账号关注／封禁空域保留。共享测试 PostgreSQL 310
passed、0 failed、6 ignored；PGlite 300 passed、0 failed、16 ignored。

本次验证真实旧 Schema 上的普通提交、尝试、源题、账号及版本未知状态可保留并
归入默认域，执行、比赛和社区内容归属非空约束已完成；账号混合事件保留有意义的空域。
这些数据库证明不替代整个服务栈、对象 存储、搜索索引及客户端的备份恢复演练。

## 接续正式 main 的最终迁移链

以上 0136–0139 是未发布主题分支的过程验收。main 已新增
0113–0115，因此正式集成保留 main 原文件，使用自动生成的追加迁移 0116
完成同样的数据归属和约束，不能将两套编号混用。

独立恢复库 `noj_upgrade_official_main_20261013b` 先通过真实 main 迁移到
0115，再执行已授权开发数据清理和合成历史夹具，最后通过标准迁移到 0116。22
个账号、3 道源题与 3 个版本、2 个板块、1 份合成普通提交、1
个正式尝试与分版本桶，以及 1 个合成 main
模型别名的原始字段逐行保留。默认域、真实 owned
binding、别名域归属与非空约束实际生效。

两次系统初始化、三次默认域初始化与两次搜索重建保持业务依据；搜索索引 25
条相同。按真实源题锁重建三个绑定的成绩投影后，原提交代码、未知提交时版本、成绩指针、有效
AC 和 10000 分保留。本人历史服务返回正确 main
信息与原代码，不返回原始评测输出或详情。

两项证明进程均退出
0：`/tmp/noj-root-official-main-domain-upgrade-proof-b-20261013.log`、`/tmp/noj-root-official-main-projections-proof-20261013.log`。详细集成决策见
[迁移记录](../../.agents/notes/implemented/architecture/2026-10-13-main-integration-domain-migration.md)。正式
S3 完整栈恢复另见
[恢复记录](../../.agents/notes/implemented/testing/2026-10-13-production-backup-isolated-full-stack-restore.md)；后者使用集成前已验证的镜像，不能代替最终集成镜像验收。
