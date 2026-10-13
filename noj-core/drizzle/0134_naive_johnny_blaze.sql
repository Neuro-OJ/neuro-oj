-- 尚未归域的 U 题需要显式处理；迁移不能删除或默默转换开发数据。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM problems WHERE domain_id IS NULL AND type = 'U') THEN
    RAISE EXCEPTION '发现尚未处理的旧 U 题，请先备份并完成授权的数据处理'
      USING ERRCODE = '55000';
  END IF;
END;
$$;--> statement-breakpoint
-- 旧生成列依赖 type，先移除再按域内数字题号重建。
ALTER TABLE "problems" DROP COLUMN "search_vector";--> statement-breakpoint
ALTER TABLE "problems" DROP CONSTRAINT "problems_type_check";--> statement-breakpoint
ALTER TABLE "problems" DROP CONSTRAINT "problems_p_visibility_check";--> statement-breakpoint
DROP INDEX "problems_legacy_type_number_unique";--> statement-breakpoint
ALTER TABLE "problems" DROP COLUMN "type";--> statement-breakpoint
ALTER TABLE "problems" ADD COLUMN "search_vector" tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
  setweight(to_tsvector('simple', coalesce(number::text, '')), 'B')
) STORED;--> statement-breakpoint
CREATE INDEX "idx_problems_search_vector" ON "problems" USING gin ("search_vector");--> statement-breakpoint
DELETE FROM role_permissions WHERE permission_id IN (
  SELECT id FROM permissions WHERE resource = 'problem' AND action = 'create_p'
);--> statement-breakpoint
DELETE FROM permissions WHERE resource = 'problem' AND action = 'create_p';
