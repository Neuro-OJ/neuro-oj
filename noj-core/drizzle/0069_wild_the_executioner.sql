ALTER TABLE "submissions" ADD COLUMN "client_ip" text;--> statement-breakpoint
CREATE INDEX "idx_submissions_contest_client_ip" ON "submissions" USING btree ("contest_id","client_ip","created_at");