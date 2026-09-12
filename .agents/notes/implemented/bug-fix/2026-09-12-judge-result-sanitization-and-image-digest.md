# Agent Note: 评测结果防御性归一、镜像 digest 白名单与迁移 advisory lock

Status: implemented

## Problem

三处纵深防御缺口（架构评审 §4.3/§4.4/§4.5）：

1. Redis 队列是 core↔judge 的**信任边界**，但 core 对回传的 `score`/`status`/`time_ms`/`memory_kb` **零校验**（`saveEvaluationResult` 直接落库），而榜单/竞赛排名 SQL 直接用 `er.score` 聚合——judge 版本回退、被替换或队列被其他主体写入都会让脏分数进入排名。仅 `details` 有白名单化（`sanitizeJudgeDetails`）。
2. `isImageInWhitelist` 的 `all_versions` 模式只比 `stripImageTag`（**忽略 tag**），而 tag 是可变的（`latest` 被覆盖、同名 tag 重新推送），无法保证"跑的还是当初审核过的镜像"；judge 侧基础镜像却早已用 `FROM ...@sha256:` 钉死。
3. drizzle 的 migrator 不加任何跨进程锁，多副本或人工并行执行时两个迁移器会竞争 `__drizzle_migrations`。

## Decision

1. 新增 `sanitizeJudgeResult()`：`status` 白名单（未知降级为 `error`）、`score` 取整并 clamp 到 `0..FULL_SCORE`、非有限值归 0、负数/非有限 `time_ms`/`memory_kb` 清空、`output` 类型与体积上限；归一结果与修正清单一起记录 WARN 日志。接入 `saveEvaluationResult`。
2. 新增 `parseImageRef()`，白名单条目登记 digest（`repo@sha256:...`）后**按 digest 匹配**（未携带 digest 的请求被拒）；未登记 digest 时保持历史语义，向后兼容存量数据。
3. `runMigrations()` 外层加 advisory lock，锁键按 schema 派生（不同测试分片互不阻塞）。

## Alternatives considered

- 结果归一放在 core 入队校验：校验不了回传路径，问题的位置在"出队落库"。
- 要求 `runtime_config` 镜像必须带 digest：会一次性打破存量题目定义，且 core 无法把 name 解析成 digest。
- 用两个 digests 列存白名单：需要新迁移与后台 UI 改动，当前"条目自带 digest"足以表达。
- 迁移锁用 `pg_advisory_lock` 通过主连接池：**实测自死锁**——测试模式池是 `max: 1`，预留唯一连接后迁移器永远拿不到连接（挂死 5 分钟）。改为独立单连接持锁（已写入注释，避免后人重犯）。

## Consequences

脏结果无法进入排名；镜像白名单可 digest 钉死；并发迁移串行化（并发验证：第二个迁移器等待，82 条迁移全部落库、58 张表）。注意 `judge_images.image` 现在允许携带 digest，后台展示与去重逻辑按原样透传字符串。
