# Agent Note: 域搜索实时授权查询与十万题性能基准

Status: implemented

## Problem

PR 的 50 个检查通过，性能 job 按既有规则跳过。合入前手动执行发现旧十万题
夹具仍含 P 分类且没有必需 domain_id。补足真实域和绑定后，旧查询实测 1040ms，
超过原 500ms 阈值；默认 64MiB PostgreSQL 共享内存也使大型并行查询报错。

## Decision

题目基准使用 main 的公开源题及 owned 绑定，保留十万行和原阈值。增加标准
`deno task test:perf`，CI 使用同一入口。

搜索直接从源题查当前可用绑定，复用既有可用性条件，合并原题目→候选绑定→
再次题目／绑定的重复查询。仍在数据库检查版本、当前域、共享范围、源状态和
比赛窗口，不依赖索引或缓存授权；删除 domain_id 已非空后不可能触发的旧空域分支。

题目与帖子索引 builder 直接携带同次 SQL 的源 domain_id，避免重建十万行时
逐条再查同一源表。权限测试检查域归属，索引仍只提供候选。

开发、E2E、生产 Compose 的 PostgreSQL 共享内存上限改为 512MiB，性能 job
使用相同配置。没有重启原开发或旧验收栈。完整基准含三次十万行重建，已实际 运行约
19 分钟，因此性能 job 的超时改为 30 分钟，不改变查询阈值。

## Alternatives considered

- 提高 500ms 阈值或忽略 benchmark：隐藏真实问题，不采用。
- 删除实时资源授权而只信搜索索引：会放行已撤销资源，不采用。
- 新增进程缓存或复杂重试／兜底：没有必要，合并重复 SQL 并配置实际资源容量。

## Consequences

catalog PostgreSQL 完整 396 项、search PostgreSQL／PGlite 各 35 项通过，源类型
检查通过。原数据库的共享内存错误在独立 512MiB PostgreSQL 的十万行诊断中
消失，查询约 308–340ms。诊断使用合成索引，不代替完整重建验收。
完整基准的首个真实十万题重建已通过，查询 324ms，阈值仍为 500ms；其余基准
继续执行。题目／帖子域事实随索引 entry 传递的 PostgreSQL／PGlite 回归各 35
项通过，新增断言确认域归属。

完整 `test:perf`、最终 core 镜像、API 回归及远端手动 CI 仍分别记录，未完成的
验证不提前写为通过。仅 source SQL 和索引携带事实变化，没有改成绩或其他授权。
