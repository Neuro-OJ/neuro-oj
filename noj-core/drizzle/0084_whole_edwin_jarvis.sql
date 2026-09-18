-- 竞赛时间**语义**约束（2026-09-14 评审 #3）
--
-- 背景：迁移 0083 为 `contests.start_time` / `end_time` 加了**形态** CHECK（正则）。
-- 但正则只能证明"形状"合法，证明不了"语义"合法：`2026-13-01T00:00:00.000Z` 完全
-- 匹配 `YYYY-MM-DDTHH:mm:ss.sssZ`，而 `::timestamptz` 会抛
-- `date/time field value out of range`。这类行一旦落库，赛期门控（读侧
-- `runningWindowCondition`）会因无法解析而 fail-closed，把该题永久判为"进行中"。
--
-- 故在原 CHECK 上追加 `pg_input_is_valid(col, 'timestamptz')`（PG 16+，按同一条解析
-- 路径判断，不抛错）。本约束是"第三道防线"，与写侧规范化、读侧按时刻比较配套。
--
-- ## 为什么 DROP 用 IF EXISTS、ADD 用 NOT VALID
--
-- 与迁移 0083 同一迁移安全考量（AGENTS.md §8.2）：生产库允许存在迁移前遗留的
-- **无法解析**的脏行（0083 的 NOT VALID 正是为此保留它们）。若这里用 drizzle-kit
-- 默认生成的裸 `ADD CONSTRAINT`（会对存量行做全表校验），一条脏行就会让迁移失败、
-- 整批迁移回滚、core 因 `depends_on` 永不启动（全站不可用）。
--
-- `NOT VALID` 只约束**其后的写入**，从而：存量脏行不阻塞上线，新写入的语义非法值
-- 一律被拒绝。`DROP CONSTRAINT IF EXISTS` 保证本迁移对"约束缺失"的库也可幂等执行。
ALTER TABLE "contests" DROP CONSTRAINT IF EXISTS "contests_time_format_check";--> statement-breakpoint
ALTER TABLE "contests" ADD CONSTRAINT "contests_time_format_check" CHECK ("contests"."start_time" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
        AND "contests"."end_time" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
        AND ("contests"."freeze_start_time" IS NULL OR "contests"."freeze_start_time" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$')
        AND pg_input_is_valid("contests"."start_time", 'timestamptz')
        AND pg_input_is_valid("contests"."end_time", 'timestamptz')
        AND ("contests"."freeze_start_time" IS NULL OR pg_input_is_valid("contests"."freeze_start_time", 'timestamptz'))) NOT VALID;
