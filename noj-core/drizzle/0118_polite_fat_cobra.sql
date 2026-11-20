DROP INDEX "idx_announcements_active_pinned_created";--> statement-breakpoint
DROP INDEX "idx_carousel_slides_enabled_sort";--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN "domain_id" text;--> statement-breakpoint
ALTER TABLE "carousel_slides" ADD COLUMN "domain_id" text;--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carousel_slides" ADD CONSTRAINT "carousel_slides_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_announcements_active_pinned_created" ON "announcements" USING btree ("domain_id","is_active","is_pinned","created_at");--> statement-breakpoint
CREATE INDEX "idx_carousel_slides_enabled_sort" ON "carousel_slides" USING btree ("domain_id","is_enabled","sort_order");
