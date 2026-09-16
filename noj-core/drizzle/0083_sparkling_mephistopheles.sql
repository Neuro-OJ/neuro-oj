-- 竞赛时间形态约束（2026-09-14 评审 C1 的第三道防线）
--
-- 背景：`contests.start_time` / `end_time` 是 ISO 8601 文本列，而赛期门控曾按
-- **字典序**与 UTC `Z` 字面量比较；`+08:00` 这类合法但非规范的形态会使比较恒假，
-- 导致门控静默 fail-open（赛期题解与通过率抑制同时失效）。
--
-- 本迁移分两步：
--   1. 规范化存量行（把可解析的形态收敛为 `toISOString()` 形态）；
--   2. 以 `NOT VALID` 添加形态 CHECK——存量中若有**无法解析**的脏行，迁移不会被
--      阻塞（NOT VALID 只对**新写入**生效），但从此脏形态无法再进入库。
--
-- 为什么不用 drizzle-kit 生成的裸 `ADD CONSTRAINT`：它在存量库上遇到任何非规范行
-- 都会失败，而迁移失败会让整批迁移回滚、core 因 `depends_on` 永不启动（全站不可用）。
-- 与 AGENTS.md §8.2「迁移安全」的三步式同一考量。
--
-- 规范化用 `::timestamptz` 再转回文本；`to_char` 保证输出与 JS `toISOString()`
-- 同形态。正则先筛出"可解析候选"（避免对无法解析的行做转换而抛错中止整批迁移），
-- 无法解析的脏行留给 NOT VALID 约束去约束其后的写入。
UPDATE "contests"
SET "start_time" = to_char(("start_time")::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
WHERE "start_time" !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
  AND "start_time" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}';--> statement-breakpoint
UPDATE "contests"
SET "end_time" = to_char(("end_time")::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
WHERE "end_time" !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
  AND "end_time" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}';--> statement-breakpoint
UPDATE "contests"
SET "freeze_start_time" = to_char(("freeze_start_time")::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
WHERE "freeze_start_time" IS NOT NULL
  AND "freeze_start_time" !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
  AND "freeze_start_time" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}';--> statement-breakpoint
ALTER TABLE "contests" ADD CONSTRAINT "contests_time_format_check" CHECK ("contests"."start_time" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
        AND "contests"."end_time" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
        AND ("contests"."freeze_start_time" IS NULL OR "contests"."freeze_start_time" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$')) NOT VALID;
