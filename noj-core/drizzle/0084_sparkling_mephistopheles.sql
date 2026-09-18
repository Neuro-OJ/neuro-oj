-- 竞赛时间形态与语义约束（2026-09-14 评审 C1 的第三道防线；评审 #3 补语义校验）
--
-- 背景：`contests.start_time` / `end_time` 是 ISO 8601 文本列，而赛期门控曾按
-- **字典序**与 UTC `Z` 字面量比较；`+08:00` 这类合法但非规范的形态会使比较恒假，
-- 导致门控静默 fail-open（赛期题解与通过率抑制同时失效）。
--
-- 本迁移分两步：
--   1. 规范化存量行（把可解析的形态收敛为 `toISOString()` 形态）；
--   2. 以 `NOT VALID` 添加形态 + 语义 CHECK——存量中若有**无法解析**的脏行，
--      迁移不会被阻塞（NOT VALID 只对**新写入**生效），但从此脏形态无法再进入库。
--
-- 为什么不用 drizzle-kit 生成的裸 `ADD CONSTRAINT`：它在存量库上遇到任何非规范行
-- 都会失败，而迁移失败会让整批迁移回滚、core 因 `depends_on` 永不启动（全站不可用）。
-- 与 AGENTS.md §8.2「迁移安全」的三步式同一考量。
--
-- ## 为什么正则预筛**不够**（评审 #3）
--
-- 原实现只用"看起来像时间"的正则预筛，随后直接 `::timestamptz`。但正则只能证明
-- **形状**：`2026-13-01T00:00:00` 完全匹配前导正则，转换时却抛
-- `date/time field value out of range`。一条这样的存量行会让整个迁移事务回滚，
-- 线上表现为 core 无法启动。故预筛改为 `pg_input_is_valid(col, 'timestamptz')`
-- （PG 16+）：它按同一条解析路径判断可否转换，**不抛错、只返回布尔**，
-- 无法解析的行原样保留，交由 NOT VALID 约束约束其后的写入。
--
-- 规范化用 `::timestamptz` 再转回文本；`to_char` 保证输出与 JS `toISOString()`
-- 同形态。转换只发生在 `pg_input_is_valid` 为真的分支（CASE 的求值顺序有保证，
-- 且只求值被选中的分支），故不可能对未验证值直接 cast。
--
-- 注意：本迁移的 CHECK 只约束**形态**。**语义**校验（月份 13 这类形状合法但无法
-- 转换的值）由后续迁移 0084 追加，避免在本迁移里改动约束定义（快照一致性）。
--
--
--
--
UPDATE "contests"
SET "start_time" = CASE
      WHEN pg_input_is_valid("start_time", 'timestamptz')
      THEN to_char(("start_time")::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ELSE "start_time"
    END
WHERE "start_time" !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
  AND "start_time" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}';--> statement-breakpoint
UPDATE "contests"
SET "end_time" = CASE
      WHEN pg_input_is_valid("end_time", 'timestamptz')
      THEN to_char(("end_time")::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ELSE "end_time"
    END
WHERE "end_time" !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
  AND "end_time" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}';--> statement-breakpoint
UPDATE "contests"
SET "freeze_start_time" = CASE
      WHEN pg_input_is_valid("freeze_start_time", 'timestamptz')
      THEN to_char(("freeze_start_time")::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ELSE "freeze_start_time"
    END
WHERE "freeze_start_time" IS NOT NULL
  AND "freeze_start_time" !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
  AND "freeze_start_time" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}';--> statement-breakpoint
ALTER TABLE "contests" ADD CONSTRAINT "contests_time_format_check" CHECK ("contests"."start_time" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
        AND "contests"."end_time" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
        AND ("contests"."freeze_start_time" IS NULL OR "contests"."freeze_start_time" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$')) NOT VALID;
