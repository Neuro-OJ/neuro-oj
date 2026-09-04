-- LLM 三表已移交 noj-llm-gateway 管理，此处不执行 DROP TABLE。
-- 仅移除 submissions 对 llm_providers 的跨域外键。
ALTER TABLE "submissions" DROP CONSTRAINT "submissions_llm_provider_config_id_llm_providers_id_fk";
