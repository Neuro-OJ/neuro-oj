ALTER TABLE "domain_llm_settings" DROP CONSTRAINT "domain_llm_settings_selection_check";--> statement-breakpoint
ALTER TABLE "domain_llm_settings" ADD CONSTRAINT "domain_llm_settings_selection_check" CHECK (("domain_llm_settings"."provider_id" IS NULL AND "domain_llm_settings"."model" IS NULL) OR ("domain_llm_settings"."provider_id" IS NOT NULL AND "domain_llm_settings"."model" IS NOT NULL AND length(trim("domain_llm_settings"."provider_id")) > 0 AND length(trim("domain_llm_settings"."model")) > 0));
--> statement-breakpoint
-- 旧默认执行配置只归入 main；重复初始化不能覆盖域管理员已经选择的模型。
INSERT INTO domain_llm_settings (domain_id, provider_id, model, revision, updated_at)
SELECT d.id, p.value::jsonb #>> '{}', m.value::jsonb #>> '{}', 1, CURRENT_TIMESTAMP::text
FROM domains d
JOIN system_settings p ON p.key = 'llm_default_provider_id'
JOIN system_settings m ON m.key = 'llm_default_model'
WHERE d.slug = 'main'
  AND jsonb_typeof(p.value::jsonb) = 'string' AND jsonb_typeof(m.value::jsonb) = 'string'
  AND length(trim(p.value::jsonb #>> '{}')) > 0 AND length(trim(m.value::jsonb #>> '{}')) > 0
ON CONFLICT (domain_id) DO NOTHING;
