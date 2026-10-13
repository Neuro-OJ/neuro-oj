CREATE TABLE "domain_storage_objects" (
	"domain_id" text NOT NULL,
	"storage_url" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "domain_storage_objects_domain_id_storage_url_pk" PRIMARY KEY("domain_id","storage_url"),
	CONSTRAINT "domain_storage_objects_size_check" CHECK ("domain_storage_objects"."byte_size" >= 0)
);
--> statement-breakpoint
CREATE TABLE "domain_storage_uploads" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"state" text DEFAULT 'reserved' NOT NULL,
	"storage_url" text,
	"created_at" text NOT NULL,
	"expires_at" text NOT NULL,
	"finished_at" text,
	CONSTRAINT "domain_storage_uploads_size_check" CHECK ("domain_storage_uploads"."byte_size" >= 0),
	CONSTRAINT "domain_storage_uploads_state_check" CHECK ("domain_storage_uploads"."state" IN ('reserved', 'settled', 'released')),
	CONSTRAINT "domain_storage_uploads_result_check" CHECK (("domain_storage_uploads"."state" = 'settled' AND "domain_storage_uploads"."storage_url" IS NOT NULL AND "domain_storage_uploads"."finished_at" IS NOT NULL) OR ("domain_storage_uploads"."state" = 'released' AND "domain_storage_uploads"."finished_at" IS NOT NULL) OR ("domain_storage_uploads"."state" = 'reserved' AND "domain_storage_uploads"."finished_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "domain_storage_objects" ADD CONSTRAINT "domain_storage_objects_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_storage_objects" ADD CONSTRAINT "domain_storage_objects_storage_url_storage_objects_storage_url_fk" FOREIGN KEY ("storage_url") REFERENCES "storage_objects"("storage_url") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_storage_uploads" ADD CONSTRAINT "domain_storage_uploads_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_storage_uploads" ADD CONSTRAINT "domain_storage_uploads_storage_url_storage_objects_storage_url_fk" FOREIGN KEY ("storage_url") REFERENCES "storage_objects"("storage_url") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_domain_storage_objects_url" ON "domain_storage_objects" USING btree ("storage_url");--> statement-breakpoint
CREATE INDEX "idx_domain_storage_uploads_domain" ON "domain_storage_uploads" USING btree ("domain_id","state");--> statement-breakpoint
CREATE INDEX "idx_domain_storage_uploads_expiry" ON "domain_storage_uploads" USING btree ("state","expires_at");
