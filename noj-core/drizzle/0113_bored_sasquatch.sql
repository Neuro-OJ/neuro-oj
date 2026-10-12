CREATE TABLE "domain_creation_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"applicant_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"preset" text NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"domain_id" text,
	"reviewed_by" text,
	"reviewed_at" text,
	"created_at" text NOT NULL,
	CONSTRAINT "domain_creation_requests_status_check" CHECK ("domain_creation_requests"."status" IN ('pending', 'approved', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "domain_feature_intervals" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"feature" text NOT NULL,
	"disabled_at" text NOT NULL,
	"enabled_at" text
);
--> statement-breakpoint
CREATE TABLE "domain_invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"email" text NOT NULL,
	"expires_at" text NOT NULL,
	"used_at" text,
	"revoked_at" text,
	"created_by" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "domain_invitations_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "domain_join_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"user_id" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reviewed_by" text,
	"reviewed_at" text,
	"created_at" text NOT NULL,
	CONSTRAINT "domain_join_requests_status_check" CHECK ("domain_join_requests"."status" IN ('pending', 'approved', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "domain_limits" (
	"domain_id" text PRIMARY KEY NOT NULL,
	"members" integer,
	"problems" integer,
	"storage_bytes" bigint,
	"submissions_per_minute" integer,
	CONSTRAINT "domain_limits_bounds_check" CHECK (("domain_limits"."members" IS NULL OR "domain_limits"."members" >= 0) AND ("domain_limits"."problems" IS NULL OR "domain_limits"."problems" >= 0) AND ("domain_limits"."storage_bytes" IS NULL OR "domain_limits"."storage_bytes" >= 0) AND ("domain_limits"."submissions_per_minute" IS NULL OR "domain_limits"."submissions_per_minute" >= 0))
);
--> statement-breakpoint
CREATE TABLE "domain_member_roles" (
	"membership_id" text NOT NULL,
	"role" text NOT NULL,
	CONSTRAINT "domain_member_roles_membership_id_role_pk" PRIMARY KEY("membership_id","role"),
	CONSTRAINT "domain_member_roles_role_check" CHECK ("domain_member_roles"."role" IN ('owner', 'admin', 'editor', 'educator', 'moderator', 'member'))
);
--> statement-breakpoint
CREATE TABLE "domain_memberships" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"joined_at" text NOT NULL,
	"left_at" text,
	CONSTRAINT "domain_memberships_identity_unique" UNIQUE("domain_id","user_id"),
	CONSTRAINT "domain_memberships_domain_id_unique" UNIQUE("domain_id","id"),
	CONSTRAINT "domain_memberships_status_check" CHECK ("domain_memberships"."status" IN ('active', 'removed'))
);
--> statement-breakpoint
CREATE TABLE "domain_resource_counters" (
	"domain_id" text NOT NULL,
	"resource" text NOT NULL,
	"used" bigint DEFAULT 0 NOT NULL,
	"reserved" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "domain_resource_counters_domain_id_resource_pk" PRIMARY KEY("domain_id","resource"),
	CONSTRAINT "domain_resource_counters_resource_check" CHECK ("domain_resource_counters"."resource" IN ('members', 'problems', 'storage_bytes')),
	CONSTRAINT "domain_resource_counters_counts_check" CHECK ("domain_resource_counters"."used" >= 0 AND "domain_resource_counters"."reserved" >= 0)
);
--> statement-breakpoint
CREATE TABLE "domains" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"owner_id" text NOT NULL,
	"preset" text NOT NULL,
	"configuration" jsonb NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"next_problem_number" integer DEFAULT 1001 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "domains_slug_unique" UNIQUE("slug"),
	CONSTRAINT "domains_slug_check" CHECK ("domains"."slug" ~ '^[a-z][a-z0-9-]{1,30}[a-z0-9]$'),
	CONSTRAINT "domains_status_check" CHECK ("domains"."status" IN ('active', 'archived', 'suspended')),
	CONSTRAINT "domains_preset_check" CHECK ("domains"."preset" IN ('community', 'education', 'team', 'custom')),
	CONSTRAINT "domains_revision_check" CHECK ("domains"."revision" >= 0 AND "domains"."next_problem_number" >= 1001),
	CONSTRAINT "domains_configuration_check" CHECK (jsonb_typeof("domains"."configuration") = 'object')
);
--> statement-breakpoint
CREATE TABLE "user_workspace_preferences" (
	"user_id" text PRIMARY KEY NOT NULL,
	"last_domain_id" text,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "domain_creation_requests" ADD CONSTRAINT "domain_creation_requests_applicant_id_users_id_fk" FOREIGN KEY ("applicant_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_creation_requests" ADD CONSTRAINT "domain_creation_requests_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_creation_requests" ADD CONSTRAINT "domain_creation_requests_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_feature_intervals" ADD CONSTRAINT "domain_feature_intervals_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_invitations" ADD CONSTRAINT "domain_invitations_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_invitations" ADD CONSTRAINT "domain_invitations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_join_requests" ADD CONSTRAINT "domain_join_requests_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_join_requests" ADD CONSTRAINT "domain_join_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_join_requests" ADD CONSTRAINT "domain_join_requests_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_limits" ADD CONSTRAINT "domain_limits_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_member_roles" ADD CONSTRAINT "domain_member_roles_membership_id_domain_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "domain_memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_memberships" ADD CONSTRAINT "domain_memberships_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_memberships" ADD CONSTRAINT "domain_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_resource_counters" ADD CONSTRAINT "domain_resource_counters_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_workspace_preferences" ADD CONSTRAINT "user_workspace_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_workspace_preferences" ADD CONSTRAINT "user_workspace_preferences_last_domain_id_domains_id_fk" FOREIGN KEY ("last_domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_domain_creation_requests_status" ON "domain_creation_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_domain_feature_intervals_domain" ON "domain_feature_intervals" USING btree ("domain_id","feature");--> statement-breakpoint
CREATE INDEX "idx_domain_invitations_domain" ON "domain_invitations" USING btree ("domain_id");--> statement-breakpoint
CREATE INDEX "idx_domain_join_requests_domain_status" ON "domain_join_requests" USING btree ("domain_id","status");--> statement-breakpoint
CREATE INDEX "idx_domain_memberships_user_status" ON "domain_memberships" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "idx_domains_owner" ON "domains" USING btree ("owner_id");