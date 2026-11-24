CREATE TABLE "llm_user_providers" (
	"user_id" text PRIMARY KEY NOT NULL,
	"base_url" text NOT NULL,
	"model" text NOT NULL,
	"encrypted_api_key" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "llm_user_providers_revision_check" CHECK ("llm_user_providers"."revision" >= 1)
);
