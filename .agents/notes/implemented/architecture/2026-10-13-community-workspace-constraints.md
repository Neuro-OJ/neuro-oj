# Agent Note: 社区内容归属收缩与账号事件保留

Status: implemented

## Problem

社区板块、帖子、评论和禁言仍允许空域；题解可以没有使用域绑定，从而绕过部分
复合外键。举报和通知则同时承载域内容与全站账号事件，不能统一改为非空。
旧恢复库两块板块仍为空域：0130 回填时默认域可能尚未初始化。

## Decision

标准 db:generate 追加 0139。四张内容表的域设为 NOT NULL，题解必须有绑定，
讨论与动态没有绑定。举报与通知增加帖子／评论同域复合外键。 CHECK
区分账号私信举报、关注、封禁与域内容；软删除目标后的内容通知仍保留原域。
多态审核动作的 message／user_ban 历史无域，其他审核目标必须有域。

迁移仅填历史 NULL：已知单域板块／禁言归 main；帖子按板块或已有真实绑定，
旧未绑定默认题解按已知默认题库补齐。评论按帖子，举报按真实目标，通知按帖子、
评论、持久举报或比赛定位回填。没有确定依据的剩余内容无法通过新约束，迁移失败，
不创建共享绑定、不改写显式域、不在运行时增加自动修复。

同步 Drizzle 与 PGlite DDL，删除无用的空域板块唯一索引。
数据库测试验证无归属拒绝、错误域关联拒绝、账号事件合法及内容历史保留，另实际
执行 0139 SQL 验证回填前后正文与绑定一致。0080 测试补标准初始化，避免 PGlite
缺少真实默认域而非业务断言失败。

## Alternatives considered

- 全部事件非空：会把账号关注、封禁及私信举报错误移入 Domain。
- 所有 NULL 无条件归 main：不能确定已有多域业务的真实使用域。
- 为讨论支持关联题目而放宽旧 context CHECK：属于单独产品变化，本批不扩展。
- 用服务检查代替收缩：空列仍可使复合外键失效。

## Consequences

标准共享回归 PostgreSQL 310 passed、0 failed、6 ignored；PGlite 300 passed、 0
failed、16 ignored。日志
`/tmp/noj-root-community-nn-shared-pg-final2-20261013.log` 和
`/tmp/noj-root-community-nn-shared-pl-final3-20261013.log`。
完整原始恢复证明库标准迁移成功，两块原板块 ID／slug 保留并归 main。 community
85、identity PostgreSQL 339／PGlite 332、search 35 的标准模块回归均通过；
已有环境限定忽略保留，没有本批新增忽略。

多态 target_id 和 report 通知的 JSON 定位仍由可信服务核对，未声称数据库具备
不存在的 JSON 外键。数据库约束不代替实时授权和结果裁剪，整套服务恢复与最终 CI
另行验收。
