CREATE TABLE "classroom_assistant_grants" (
	"membership_id" text NOT NULL,
	"capability" text NOT NULL,
	"granted_by" text NOT NULL,
	"granted_at" text NOT NULL,
	CONSTRAINT "classroom_assistant_grants_membership_id_capability_pk" PRIMARY KEY("membership_id","capability"),
	CONSTRAINT "classroom_assistant_grants_capability_check" CHECK ("classroom_assistant_grants"."capability" IN ('progress:read','submissions:read','assignments:manage','feedback:write','help:manage','students:manage'))
);
--> statement-breakpoint
CREATE TABLE "classroom_contest_links" (
	"domain_id" text NOT NULL,
	"classroom_id" text NOT NULL,
	"contest_id" text NOT NULL,
	"linked_by" text NOT NULL,
	"linked_at" text NOT NULL,
	CONSTRAINT "classroom_contest_links_classroom_id_contest_id_pk" PRIMARY KEY("classroom_id","contest_id")
);
--> statement-breakpoint
CREATE TABLE "classroom_join_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"classroom_id" text NOT NULL,
	"user_id" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reviewed_by" text,
	"created_at" text NOT NULL,
	"reviewed_at" text,
	CONSTRAINT "classroom_join_requests_status_check" CHECK ("classroom_join_requests"."status" IN ('pending', 'approved', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "classroom_memberships" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"classroom_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"joined_at" text NOT NULL,
	"appointed_at" text NOT NULL,
	"left_at" text,
	CONSTRAINT "classroom_memberships_identity_unique" UNIQUE("classroom_id","user_id"),
	CONSTRAINT "classroom_memberships_domain_id_unique" UNIQUE("domain_id","id"),
	CONSTRAINT "classroom_memberships_recipient_unique" UNIQUE("domain_id","classroom_id","user_id"),
	CONSTRAINT "classroom_memberships_role_check" CHECK ("classroom_memberships"."role" IN ('coach', 'assistant', 'student')),
	CONSTRAINT "classroom_memberships_status_check" CHECK ("classroom_memberships"."status" IN ('active', 'removed'))
);
--> statement-breakpoint
CREATE TABLE "classrooms" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"stage_tag" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"primary_coach_id" text NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "classrooms_domain_id_unique" UNIQUE("domain_id","id"),
	CONSTRAINT "classrooms_status_check" CHECK ("classrooms"."status" IN ('active', 'archived')),
	CONSTRAINT "classrooms_revision_check" CHECK ("classrooms"."revision" >= 0)
);
--> statement-breakpoint
ALTER TABLE "contests" ADD COLUMN "domain_id" text;
--> statement-breakpoint
ALTER TABLE "contests" ADD CONSTRAINT "contests_domain_id_unique" UNIQUE("domain_id","id");
--> statement-breakpoint
ALTER TABLE "classroom_assistant_grants" ADD CONSTRAINT "classroom_assistant_grants_membership_id_classroom_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "classroom_memberships"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "classroom_assistant_grants" ADD CONSTRAINT "classroom_assistant_grants_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "classroom_contest_links" ADD CONSTRAINT "classroom_contest_links_linked_by_users_id_fk" FOREIGN KEY ("linked_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "classroom_contest_links" ADD CONSTRAINT "classroom_contest_links_classroom_domain_fk" FOREIGN KEY ("domain_id","classroom_id") REFERENCES "classrooms"("domain_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "classroom_contest_links" ADD CONSTRAINT "classroom_contest_links_contest_domain_fk" FOREIGN KEY ("domain_id","contest_id") REFERENCES "contests"("domain_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "classroom_join_requests" ADD CONSTRAINT "classroom_join_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "classroom_join_requests" ADD CONSTRAINT "classroom_join_requests_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "classroom_join_requests" ADD CONSTRAINT "classroom_join_requests_classroom_domain_fk" FOREIGN KEY ("domain_id","classroom_id") REFERENCES "classrooms"("domain_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "classroom_memberships" ADD CONSTRAINT "classroom_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "classroom_memberships" ADD CONSTRAINT "classroom_memberships_classroom_domain_fk" FOREIGN KEY ("domain_id","classroom_id") REFERENCES "classrooms"("domain_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "classroom_memberships" ADD CONSTRAINT "classroom_memberships_member_domain_fk" FOREIGN KEY ("domain_id","user_id") REFERENCES "domain_memberships"("domain_id","user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "classrooms" ADD CONSTRAINT "classrooms_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "classrooms" ADD CONSTRAINT "classrooms_primary_coach_id_users_id_fk" FOREIGN KEY ("primary_coach_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "classrooms" ADD CONSTRAINT "classrooms_coach_domain_fk" FOREIGN KEY ("domain_id","primary_coach_id") REFERENCES "domain_memberships"("domain_id","user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "classroom_join_requests_pending_unique" ON "classroom_join_requests" USING btree ("classroom_id","user_id") WHERE "classroom_join_requests"."status" = 'pending';
--> statement-breakpoint
CREATE INDEX "idx_classroom_memberships_domain_user" ON "classroom_memberships" USING btree ("domain_id","user_id","status");
--> statement-breakpoint
CREATE INDEX "idx_classrooms_domain_status" ON "classrooms" USING btree ("domain_id","status","created_at");
--> statement-breakpoint
ALTER TABLE "contests" ADD CONSTRAINT "contests_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;
