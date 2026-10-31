ALTER TABLE "legal_document_versions" DROP COLUMN "tsa_provider";--> statement-breakpoint
ALTER TABLE "legal_document_versions" DROP COLUMN "tsa_token";--> statement-breakpoint
ALTER TABLE "legal_document_versions" DROP COLUMN "tsa_chain";--> statement-breakpoint
ALTER TABLE "legal_document_versions" DROP COLUMN "tsa_query";--> statement-breakpoint
ALTER TABLE "legal_document_versions" DROP COLUMN "tsa_timestamp";--> statement-breakpoint
DELETE FROM "system_settings" WHERE "key" IN ('tsa_provider', 'tsa_url', 'tsa_root_cert');
