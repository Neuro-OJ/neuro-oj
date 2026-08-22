CREATE TABLE "tfa_recovery_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"used_at" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "tfa_secret_encrypted" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "tfa_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tfa_recovery_codes" ADD CONSTRAINT "tfa_recovery_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_tfa_recovery_codes_user_id" ON "tfa_recovery_codes" USING btree ("user_id");