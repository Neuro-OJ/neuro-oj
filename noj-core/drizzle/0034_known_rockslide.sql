ALTER TABLE "problems" DROP CONSTRAINT "problems_type_check";--> statement-breakpoint
ALTER TABLE "problems" ADD COLUMN "is_objective" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- 0033 放宽期间可能已产生 type='O' 数据：按新设计转换为 U 型客观题套卷。
-- 先为 O 行分配不与 U/P 冲突的 number（MAX(U/P)+100+原 number，保证唯一），
-- 再改 type，避免违反 UNIQUE(type, number)。
UPDATE "problems" SET "number" = (
  SELECT COALESCE(MAX("number"), 0) + 100 FROM "problems" WHERE "type" IN ('U', 'P')
) + "number" WHERE "type" = 'O';--> statement-breakpoint
UPDATE "problems" SET "type" = 'U', "is_objective" = true WHERE "type" = 'O';--> statement-breakpoint
ALTER TABLE "problems" ADD CONSTRAINT "problems_type_check" CHECK ("problems"."type" IN ('U', 'P'));