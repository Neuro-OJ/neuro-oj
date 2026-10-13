# Agent Note: 旧治理入口区分 main 内容授权与账号私信

Status: implemented

## Problem

旧 `/admin/community/reports` 与 `/content-review` 只检查全站审核权限。 main
变为成员入口或关闭社区后，审核员仍能读取内容快照并操作记录；统一审核队列没有域列，私有学校的机器审核快照还可能进入旧混合列表。
私信属于统一账号关系，不能因 main 的社区政策失去平台治理入口。

## Decision

旧举报与审核队列默认混合列表先检查 main 的当前进入、状态和社区模块政策。
举报新增 `content_type=message` 专项查询；审核队列沿用 `channel=dm` 或
`content_type=message`。专项查询仅包含账号消息，不依赖 main。
单项操作从持久目标分类：内容检查 main，消息保持原平台权限。
举报目标只读取一次，供授权、乐观锁和处理复用；内容变更与重新开启使用同一已授权事务。

审核队列在 SQL 分页和计数前限定 main 内容及账号消息。
目标存在时使用其真实域，元数据不能覆盖实际私域；目标未落库时使用服务器保存的
`meta.domain_id`。UGC
审核生产入口从可信社区上下文写入该字段，拦截后快照仍有明确归属。
历史孤立快照缺少域依据时不猜
main，也不在旧入口暴露。其他域和未知归属记录的详情及写操作统一返回 404。

## Alternatives considered

- main
  授权失败后自动降级成消息列表：同一查询会静默改变结果含义，改为明确专项查询。
- 在内存中丢弃其他域记录：分页总数与快照仍可能泄露，筛选置于 SQL。
- 将缺失目标和元数据的历史记录全当 main：无法区分新私域孤立快照，不采用。
- 每个处理步骤重复查询目标或增加通用授权绕过参数：复用已经解析的目标与事务。

## Consequences

标准 community 回归在 PostgreSQL 与 PGlite 各通过 82 项，包含 main
私有访问、模块停用、 私信专项读写、错误域
ID、真实目标优先及分页计数；content-review 两库各通过 11 项。 本批不修改 Schema
或迁移，也不清除历史审核数据。

`pages/admin/content-review.vue` 已有专项筛选，可以使用该契约。
`pages/admin/reports.vue` 尚需消息筛选传 `content_type=message`， 才能在 main
不可用时独立处理私信；本批仅实现后端，没有修改前端。
