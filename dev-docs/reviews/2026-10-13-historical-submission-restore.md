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

## 验收边界

本次验证真实旧 Schema 上的普通提交、尝试、源题、账号及版本未知状态可保留并
归入默认域。不代表全部执行表已完成 NOT NULL 收缩，也不替代整个服务栈、对象
存储、搜索索引及客户端的备份恢复演练。
