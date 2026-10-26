CREATE TABLE "domain_invitation_redemptions" (
	"invitation_id" text NOT NULL,
	"user_id" text NOT NULL,
	"redeemed_at" text NOT NULL,
	CONSTRAINT "domain_invitation_redemptions_invitation_id_user_id_pk" PRIMARY KEY("invitation_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "domain_invitations" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "domain_invitations" ADD COLUMN "code_hash" text;--> statement-breakpoint
ALTER TABLE "domain_invitations" ADD COLUMN "mode" text DEFAULT 'email' NOT NULL;--> statement-breakpoint
ALTER TABLE "domain_invitations" ADD COLUMN "max_uses" integer DEFAULT 1;--> statement-breakpoint
ALTER TABLE "domain_invitations" ADD COLUMN "used_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "domain_invitations" SET "used_count" = 1 WHERE "used_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "domain_invitation_redemptions" ADD CONSTRAINT "domain_invitation_redemptions_invitation_id_domain_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "domain_invitations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_invitation_redemptions" ADD CONSTRAINT "domain_invitation_redemptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_invitations" ADD CONSTRAINT "domain_invitations_code_hash_unique" UNIQUE("code_hash");--> statement-breakpoint
ALTER TABLE "domain_invitations" ADD CONSTRAINT "domain_invitations_mode_check" CHECK ("domain_invitations"."mode" IN ('email','general','once'));--> statement-breakpoint
ALTER TABLE "domain_invitations" ADD CONSTRAINT "domain_invitations_uses_check" CHECK ("domain_invitations"."used_count" >= 0 AND ("domain_invitations"."max_uses" IS NULL OR "domain_invitations"."max_uses" > 0));--> statement-breakpoint
ALTER TABLE "domain_invitations" ADD CONSTRAINT "domain_invitations_target_check" CHECK (("domain_invitations"."mode" = 'email' AND "domain_invitations"."email" IS NOT NULL AND "domain_invitations"."max_uses" = 1) OR ("domain_invitations"."mode" = 'once' AND "domain_invitations"."email" IS NULL AND "domain_invitations"."max_uses" = 1) OR ("domain_invitations"."mode" = 'general' AND "domain_invitations"."email" IS NULL));
