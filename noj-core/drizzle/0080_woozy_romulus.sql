-- 注意：本文件由 drizzle-kit 生成后**手工修正**为三步式加列，请勿改回一步式。
--
-- 原因：drizzle-kit 原始生成结果为 `ADD COLUMN "updated_at" text NOT NULL`，
-- 既无 DEFAULT 也无回填。PostgreSQL 允许空表直接添加 NOT NULL 列，但**存量库**上
-- 这四张表运行时必有数据（社区举报/处罚、IP 封禁、用户封禁），加列会因存在 NULL
-- 而失败。更严重的是 drizzle migrator 把整批待执行迁移包在单个事务内，失败即整批
-- 回滚并使 migrate 服务非零退出，而 core 依赖 `migrate: service_completed_successfully`
-- → 全站无法启动。
--
-- 该缺陷只在**升级路径**暴露（全新安装的空库无法发现），因此配套新增了
-- `tests/db/migration_0080_backfill_test.ts`（在有数据的表上执行本文件）
-- 与 `scripts/check-migration-safety.ts`（静态拦截同类写法）。
--
-- 修正方式：先加可空列 → 用 created_at 回填 → 再置 NOT NULL。
ALTER TABLE "community_reports" ADD COLUMN "updated_at" text;--> statement-breakpoint
UPDATE "community_reports" SET "updated_at" = "created_at" WHERE "updated_at" IS NULL;--> statement-breakpoint
ALTER TABLE "community_reports" ALTER COLUMN "updated_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "community_sanctions" ADD COLUMN "updated_at" text;--> statement-breakpoint
UPDATE "community_sanctions" SET "updated_at" = "created_at" WHERE "updated_at" IS NULL;--> statement-breakpoint
ALTER TABLE "community_sanctions" ALTER COLUMN "updated_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "ip_bans" ADD COLUMN "updated_at" text;--> statement-breakpoint
UPDATE "ip_bans" SET "updated_at" = "created_at" WHERE "updated_at" IS NULL;--> statement-breakpoint
ALTER TABLE "ip_bans" ALTER COLUMN "updated_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "user_bans" ADD COLUMN "updated_at" text;--> statement-breakpoint
UPDATE "user_bans" SET "updated_at" = "banned_at" WHERE "updated_at" IS NULL;--> statement-breakpoint
ALTER TABLE "user_bans" ALTER COLUMN "updated_at" SET NOT NULL;
