# Agent Note: 全量并行回归中的公开题与客观比赛夹具归属

Status: implemented

## Problem

在全新隔离 PostgreSQL 数据库执行标准 core 并行回归，首轮 unit 分片为 380 通过、0
失败、6 ignored，db 分片为 1837 通过、20 失败、11
ignored。失败包括题库公共列表两项、客观题比赛七项，以及由其他实施范围处理的统计和搜索十一项，不能把这轮记录作为全量通过。

公共列表夹具直接插入题目时没有声明公开可见性。取消 P/U
后，题目默认私有，已有基线版本 helper
按真实可见性建立成员绑定，匿名查询排除这些记录符合产品规则。客观题比赛夹具没有给比赛父记录
Domain，而赛题 helper 明确使用默认域，复合外键正确拒绝不一致的父子关系。

## Decision

仅修改两个 catalog 路由测试和三个 objective 服务测试。公共题夹具显式写入
`visibility: public`，继续使用匿名列表读取；清理使用现有
`deleteProblemFixtures`，先移除题库绑定再删除已释放其他依据的测试题目。没有改变
helper 的基线发布或绑定策略。

客观题比赛父记录显式写入
`DEFAULT_DOMAIN_ID`，与真实默认域题目绑定和赛题复合外键一致。保留比赛题型、一次交卷、固定版本、赛中结果裁剪和赛后复盘的原断言，不添加
Domain fallback，不放宽数据库约束或生产权限。

原开发数据库和正在运行的 E2E 库不参与回归。新库为
`noj_upgrade_regression_20261013d`，全量使用标准独立 schema 分片。因为脚本会清空
Redis 分片，本轮单独创建临时 Redis 实例监听 6390，不清空开发或 Native E2E 的
Redis。

## Alternatives considered

- 给匿名列表测试传管理员凭据：会绕过公共可见性的真实行为，故明确建立公开题。
- 在赛题 helper 中自动修补比赛父记录：会掩盖父记录缺失归属，故在具体夹具声明
  Domain。
- 删除复合外键或对缺绑定做生产 fallback：违背统一域模型，故只修夹具。
- 在开发数据库重建测试状态：不能保护用户数据，故使用新测试数据库与临时 Redis。

## Consequences

两个题库原失败用例通过标准 catalog 过滤入口验证，结果为 2 通过、0
失败。Objective 全模块在 PostgreSQL 和 PGlite 均为 66 通过、0 失败。

日志分别为
`/tmp/noj-core-parallel-20261013d.log`、`/tmp/noj-catalog-public-fixture-focused.log`、`/tmp/noj-objective-full-fixture-pg.log`
和 `/tmp/noj-objective-full-fixture-pglite.log`。完整最新快照的并行重跑由主
agent 在所有相关整改冻结后执行，以上局部通过不替代最后全量门禁。
