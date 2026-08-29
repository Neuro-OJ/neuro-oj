CREATE TABLE "oauth_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"provider_user_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider_username" text,
	"provider_email" text,
	"email_verified" boolean DEFAULT false NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "oauth_accounts_provider_identity_unique" UNIQUE("provider","provider_user_id")
);
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_accounts" ADD CONSTRAINT "oauth_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_oauth_accounts_user_id" ON "oauth_accounts" USING btree ("user_id");