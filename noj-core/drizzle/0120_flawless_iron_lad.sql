ALTER TABLE "classrooms" ADD COLUMN "archived_at" text;--> statement-breakpoint
ALTER TABLE "domain_invitations" ADD COLUMN "classroom_id" text;--> statement-breakpoint
ALTER TABLE "domain_invitations" ADD CONSTRAINT "domain_invitations_classroom_domain_fk" FOREIGN KEY ("domain_id","classroom_id") REFERENCES "classrooms"("domain_id","id") ON DELETE no action ON UPDATE no action;
