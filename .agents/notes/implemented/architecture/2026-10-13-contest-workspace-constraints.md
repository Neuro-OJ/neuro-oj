# Agent Note: 比赛归属非空与同域提交约束

Status: implemented

## Problem

比赛与赛题仍允许空域和空题库绑定，复合外键的 MATCH SIMPLE 会使空列绕过关系约束。
普通和客观题提交已有同域题库关系，但数据库尚未保证其比赛上下文属于同一使用域。

## Decision

迁移 0138 由标准 db:generate 生成，仅追加。比赛域、赛题域及绑定设为 NOT NULL；
两种正式提交新增 `(domain_id, contest_id)` 到比赛的复合外键。 保持既有单列
contest_id 的 ON DELETE SET NULL，复合外键采用 NO ACTION。
练习仍允许空比赛；删除比赛不删除提交、答案或评测尝试，也不清空域和题库绑定。
Drizzle Schema 与 PGlite DDL 同步，测试夹具按父比赛真实使用域填写绑定。

实例尚未上线，原开发库五场旧比赛已依用户授权备份并清理，因此不编写旧赛制兼容
或推测性历史比赛回填。新的生产比赛写入已使用明确域和绑定。
完整历史恢复证明库在保留原题及合成历史提交的前提下，标准迁移至 0138 成功。

## Alternatives considered

- 让 NULL 继续绕过复合外键：不能落实使用域不变量。
- 按源题所在域填比赛域：共享题参与学校比赛时归属错误。
- 将整个复合键 SET NULL：会清空必须保留的提交域。
- 兼容尚不存在的线上旧比赛：超出已确认范围。

## Consequences

新增三个真实数据库回归验证缺少归属被拒绝、错误域比赛关联被拒绝、练习空上下文
及删除比赛后原代码／答案／尝试保留。标准共享测试 PostgreSQL 306 passed、 0
failed、6 ignored；PGlite 296 passed、0 failed、16 ignored。忽略项均为既有
运行环境限定，不为本批新增忽略。日志分别为
`/tmp/noj-root-contest-nn-shared-pg-final-20261013.log` 与
`/tmp/noj-root-contest-nn-shared-pl-final-20261013.log`。

外键证明关联身份，不代替参赛权限、当前共享授权、时间窗口或结果裁剪。
本批没有重跑全部浏览器或远端 CI，社区归属收缩另行处理。
