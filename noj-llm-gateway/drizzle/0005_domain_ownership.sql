ALTER TABLE llm_providers ADD COLUMN domain_id text;
UPDATE llm_providers SET domain_id = '00000000-0000-4000-8000-000000000001' WHERE domain_id IS NULL;
ALTER TABLE llm_providers ALTER COLUMN domain_id SET NOT NULL;
CREATE INDEX idx_llm_providers_domain ON llm_providers(domain_id);

ALTER TABLE llm_usage ADD COLUMN domain_id text;
UPDATE llm_usage SET domain_id = '00000000-0000-4000-8000-000000000001' WHERE domain_id IS NULL;
ALTER TABLE llm_usage ALTER COLUMN domain_id SET NOT NULL;
CREATE INDEX idx_llm_usage_domain_created ON llm_usage(domain_id, created_at);

ALTER TABLE llm_quotas ADD COLUMN domain_id text;
UPDATE llm_quotas SET domain_id = CASE WHEN scope_type = 'global' THEN '' ELSE '00000000-0000-4000-8000-000000000001' END;
ALTER TABLE llm_quotas ALTER COLUMN domain_id SET DEFAULT '';
ALTER TABLE llm_quotas ALTER COLUMN domain_id SET NOT NULL;
ALTER TABLE llm_quotas ALTER COLUMN max_calls DROP NOT NULL;
ALTER TABLE llm_quotas ALTER COLUMN max_calls DROP DEFAULT;
ALTER TABLE llm_quotas ALTER COLUMN max_tokens DROP NOT NULL;
ALTER TABLE llm_quotas ALTER COLUMN max_tokens DROP DEFAULT;
ALTER TABLE llm_quotas ALTER COLUMN max_cost DROP NOT NULL;
ALTER TABLE llm_quotas ALTER COLUMN max_cost DROP DEFAULT;
DROP INDEX idx_llm_quotas_scope;
CREATE INDEX idx_llm_quotas_scope ON llm_quotas(domain_id, scope_type, scope_id, window_type);
