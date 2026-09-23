CREATE TABLE "data_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"detail" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"handled_by" text,
	"handled_at" text,
	"resolution" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "data_requests_kind_check" CHECK ("data_requests"."kind" IN ('delete', 'correct')),
	CONSTRAINT "data_requests_status_check" CHECK ("data_requests"."status" IN ('pending', 'processing', 'resolved', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "legal_document_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"version" integer NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"change_summary" text,
	"is_material" boolean DEFAULT false NOT NULL,
	"published_at" text NOT NULL,
	"created_by" text,
	"tsa_provider" text,
	"tsa_token" text,
	"tsa_chain" text,
	CONSTRAINT "legal_document_versions_doc_version_unique" UNIQUE("document_id","version")
);
--> statement-breakpoint
CREATE TABLE "legal_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"current_version" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "legal_documents_kind_unique" UNIQUE("kind"),
	CONSTRAINT "legal_documents_kind_check" CHECK ("legal_documents"."kind" IN ('privacy', 'terms'))
);
--> statement-breakpoint
CREATE TABLE "user_consents" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"document_kind" text NOT NULL,
	"version" integer NOT NULL,
	"content_hash" text NOT NULL,
	"agreed_at" text NOT NULL,
	"ip" text,
	"user_agent" text,
	CONSTRAINT "user_consents_user_doc_version_unique" UNIQUE("user_id","document_kind","version")
);
--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN "banner_text" text;--> statement-breakpoint
ALTER TABLE "data_requests" ADD CONSTRAINT "data_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_requests" ADD CONSTRAINT "data_requests_handled_by_users_id_fk" FOREIGN KEY ("handled_by") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_document_versions" ADD CONSTRAINT "legal_document_versions_document_id_legal_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "legal_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_document_versions" ADD CONSTRAINT "legal_document_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_consents" ADD CONSTRAINT "user_consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_data_requests_status_created" ON "data_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "idx_data_requests_user" ON "data_requests" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_legal_versions_material" ON "legal_document_versions" USING btree ("document_id","is_material","version");