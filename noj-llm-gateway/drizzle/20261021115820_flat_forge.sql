CREATE TABLE "llm_gateway_domain_settings" (
	"domain_id" text PRIMARY KEY NOT NULL,
	"provider_id" text,
	"model" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" text NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "llm_gateway_domain_settings_revision_check" CHECK ("llm_gateway_domain_settings"."revision" >= 1),
	CONSTRAINT "llm_gateway_domain_settings_selection_check" CHECK (("llm_gateway_domain_settings"."provider_id" IS NULL AND "llm_gateway_domain_settings"."model" IS NULL) OR
        ("llm_gateway_domain_settings"."provider_id" IS NOT NULL AND "llm_gateway_domain_settings"."model" IS NOT NULL
          AND length(trim("llm_gateway_domain_settings"."provider_id")) > 0
          AND length(trim("llm_gateway_domain_settings"."model")) > 0))
);
--> statement-breakpoint
CREATE TABLE "llm_gateway_model_aliases" (
	"domain_id" text NOT NULL,
	"alias" text NOT NULL,
	"provider_id" text NOT NULL,
	"model" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" text NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "llm_gateway_model_aliases_domain_id_alias_pk" PRIMARY KEY("domain_id","alias"),
	CONSTRAINT "llm_gateway_model_aliases_revision_check" CHECK ("llm_gateway_model_aliases"."revision" >= 1)
);
--> statement-breakpoint
CREATE INDEX "idx_llm_gateway_model_aliases_domain" ON "llm_gateway_model_aliases" USING btree ("domain_id");
--> statement-breakpoint
-- Gateway 首次接管模型执行权时，尽量把同库中的旧 Core 配置带入新权威表。
-- 独立 Gateway 测试库没有 Core 表，因此必须按表是否存在条件执行；后续运行
-- 时只用 Gateway 表，不再把这些旧表当作 fallback。
DO $$
BEGIN
  IF to_regclass('public.domain_llm_settings') IS NOT NULL THEN
    EXECUTE $sql$
      INSERT INTO llm_gateway_domain_settings
        (domain_id, provider_id, model, revision, updated_at, updated_by)
      SELECT domain_id, provider_id, model, GREATEST(COALESCE(revision, 0), 1),
        updated_at, 'migration:core-domain-llm-settings'
      FROM domain_llm_settings
      ON CONFLICT (domain_id) DO NOTHING
    $sql$;
  END IF;
  IF to_regclass('public.llm_model_aliases') IS NOT NULL THEN
    EXECUTE $sql$
      INSERT INTO llm_gateway_model_aliases
        (domain_id, alias, provider_id, model, description, revision,
         updated_at, updated_by)
      SELECT domain_id, alias, provider_id, model, description,
        GREATEST(COALESCE(revision, 0), 1), updated_at,
        COALESCE(updated_by, 'migration:core-llm-model-aliases')
      FROM llm_model_aliases
      WHERE alias <> 'default'
      ON CONFLICT (domain_id, alias) DO NOTHING
    $sql$;
  END IF;
END $$;
