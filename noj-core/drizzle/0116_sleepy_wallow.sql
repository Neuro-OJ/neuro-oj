ALTER TABLE "problems" DROP CONSTRAINT "problems_type_number_unique";--> statement-breakpoint
DROP INDEX "idx_problems_domain_number";--> statement-breakpoint
CREATE UNIQUE INDEX "problems_legacy_type_number_unique" ON "problems" USING btree ("type","number") WHERE "problems"."domain_id" IS NULL;--> statement-breakpoint
ALTER TABLE "problems" ADD CONSTRAINT "problems_domain_number_unique" UNIQUE("domain_id","number");