CREATE TABLE "llm_token_revocations" (
	"id" text PRIMARY KEY NOT NULL,
	"attempt_id" text NOT NULL,
	"submission_id" text,
	"ttl_seconds" integer NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL,
	"done_at" text,
	CONSTRAINT "llm_token_revocations_state_check" CHECK ("llm_token_revocations"."state" IN ('pending', 'done'))
);
--> statement-breakpoint
CREATE INDEX "idx_llm_token_revocations_pending" ON "llm_token_revocations" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "idx_llm_token_revocations_attempt" ON "llm_token_revocations" USING btree ("attempt_id");