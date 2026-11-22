CREATE TABLE "llm_call_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"state" text NOT NULL,
	"reservation" jsonb NOT NULL,
	"settlement" jsonb,
	"settlement_result" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_llm_call_ledger_state_created" ON "llm_call_ledger" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "idx_llm_call_ledger_domain_created" ON "llm_call_ledger" USING btree ("domain_id","created_at");