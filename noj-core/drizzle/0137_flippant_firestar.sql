-- 迁移前检查：异常数据必须显式中止，不能静默改归属、转换权限或丢弃历史。
DO $$
DECLARE
  cross_domain integer;
  bad_preset integer;
  bad_request_preset integer;
BEGIN
  SELECT count(*) INTO cross_domain
  FROM domain_problem_bindings b
  JOIN problems p ON p.id = b.problem_id
  WHERE p.domain_id <> b.domain_id;
  IF cross_domain > 0 THEN
    RAISE EXCEPTION '检测到 % 条跨域题目绑定：请先复制到使用域并删除旧绑定后再迁移', cross_domain;
  END IF;
  SELECT count(*) INTO bad_preset
  FROM domains WHERE preset NOT IN ('community', 'education', 'team');
  IF bad_preset > 0 THEN
    RAISE EXCEPTION '检测到 % 个未知域类型：仅支持 community/education/team', bad_preset;
  END IF;
  SELECT count(*) INTO bad_request_preset
  FROM domain_creation_requests
  WHERE preset NOT IN ('community', 'education', 'team');
  IF bad_request_preset > 0 THEN
    RAISE EXCEPTION '检测到 % 条未知域类型的创建申请', bad_request_preset;
  END IF;
END $$;--> statement-breakpoint
DROP TABLE "domain_training_bindings";--> statement-breakpoint
ALTER TABLE "domain_problem_bindings" DROP CONSTRAINT "domain_problem_bindings_kind_check";--> statement-breakpoint
ALTER TABLE "domains" DROP CONSTRAINT "domains_preset_check";--> statement-breakpoint
ALTER TABLE "domain_problem_bindings" ADD CONSTRAINT "domain_problem_bindings_problem_domain_fk" FOREIGN KEY ("domain_id","problem_id") REFERENCES "problems"("domain_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_problem_bindings" DROP COLUMN "kind";--> statement-breakpoint
ALTER TABLE "domain_creation_requests" ADD CONSTRAINT "domain_creation_requests_preset_check" CHECK ("domain_creation_requests"."preset" IN ('community', 'education', 'team'));--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_preset_check" CHECK ("domains"."preset" IN ('community', 'education', 'team'));
