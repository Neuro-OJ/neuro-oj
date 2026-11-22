-- 既有 U 题与旧比赛需先备份并完成明确授权的数据处理，迁移不删除业务数据。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM problems WHERE type = 'U') THEN
    RAISE EXCEPTION '发现尚未处理的旧 U 题，请先备份并完成授权的数据处理' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM contests) THEN
    RAISE EXCEPTION '发现旧比赛，请先备份并完成授权的数据处理' USING ERRCODE = '55000';
  END IF;
END $$;
--> statement-breakpoint
CREATE SEQUENCE "submission_receipt_sequence" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;
--> statement-breakpoint
CREATE TABLE "assignment_feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"assignment_id" text NOT NULL,
	"target_user_id" text,
	"author_id" text NOT NULL,
	"body" text NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"deleted_at" text,
	CONSTRAINT "assignment_feedback_scope_unique" UNIQUE("domain_id","assignment_id","id"),
	CONSTRAINT "assignment_feedback_revision_check" CHECK ("assignment_feedback"."revision" >= 0),
	CONSTRAINT "assignment_feedback_body_check" CHECK (char_length("assignment_feedback"."body") BETWEEN 1 AND 30000)
);
--> statement-breakpoint
CREATE TABLE "assignment_help_replies" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"assignment_id" text NOT NULL,
	"help_id" text NOT NULL,
	"author_id" text NOT NULL,
	"body" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "assignment_help_replies_scope_unique" UNIQUE("domain_id","assignment_id","id"),
	CONSTRAINT "assignment_help_replies_body_check" CHECK (char_length("assignment_help_replies"."body") BETWEEN 1 AND 30000)
);
--> statement-breakpoint
CREATE TABLE "assignment_help_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"assignment_id" text NOT NULL,
	"user_id" text NOT NULL,
	"item_id" text,
	"submission_id" text,
	"objective_submission_id" text,
	"body" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"handled_by" text,
	"handled_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "assignment_help_requests_scope_unique" UNIQUE("domain_id","assignment_id","id"),
	CONSTRAINT "assignment_help_requests_source_check" CHECK (NOT ("assignment_help_requests"."submission_id" IS NOT NULL AND "assignment_help_requests"."objective_submission_id" IS NOT NULL)),
	CONSTRAINT "assignment_help_requests_state_check" CHECK ("assignment_help_requests"."state" IN ('open','resolved')),
	CONSTRAINT "assignment_help_requests_revision_check" CHECK ("assignment_help_requests"."revision" >= 0),
	CONSTRAINT "assignment_help_requests_body_check" CHECK (char_length("assignment_help_requests"."body") BETWEEN 1 AND 30000)
);
--> statement-breakpoint
CREATE TABLE "assignment_item_history" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"item_id" text NOT NULL,
	"binding_history_id" text,
	"problem_id" text NOT NULL,
	"answer_version_id" text,
	"policy_mode" text NOT NULL,
	"required_version_id" text,
	"policy_revision" integer NOT NULL,
	"reason" text NOT NULL,
	"actor_id" text,
	"created_at" text NOT NULL,
	CONSTRAINT "assignment_item_history_binding_change_unique" UNIQUE("item_id","binding_history_id"),
	CONSTRAINT "assignment_item_history_policy_check" CHECK (("assignment_item_history"."policy_mode" = 'any' AND "assignment_item_history"."required_version_id" IS NULL) OR
      ("assignment_item_history"."policy_mode" = 'exact' AND "assignment_item_history"."required_version_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "assignment_items" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"assignment_id" text NOT NULL,
	"problem_id" text NOT NULL,
	"binding_id" text NOT NULL,
	"sort_order" integer NOT NULL,
	"requirement" text NOT NULL,
	"minimum_score" integer,
	"published_version_id" text,
	"published_policy_mode" text DEFAULT 'any' NOT NULL,
	"published_required_version_id" text,
	"published_policy_revision" integer DEFAULT 0 NOT NULL,
	"answer_version_id" text,
	"policy_revision" integer DEFAULT 0 NOT NULL,
	"resource_available" boolean DEFAULT true NOT NULL,
	CONSTRAINT "assignment_items_domain_id_unique" UNIQUE("domain_id","id"),
	CONSTRAINT "assignment_items_id_problem_unique" UNIQUE("id","problem_id"),
	CONSTRAINT "assignment_items_assignment_id_unique" UNIQUE("domain_id","assignment_id","id"),
	CONSTRAINT "assignment_items_problem_unique" UNIQUE("assignment_id","problem_id"),
	CONSTRAINT "assignment_items_order_unique" UNIQUE("assignment_id","sort_order"),
	CONSTRAINT "assignment_items_requirement_check" CHECK (("assignment_items"."requirement" = 'accepted' AND "assignment_items"."minimum_score" IS NULL) OR
    ("assignment_items"."requirement" = 'min_score' AND "assignment_items"."minimum_score" IS NOT NULL AND "assignment_items"."minimum_score" BETWEEN 0 AND 10000)),
	CONSTRAINT "assignment_items_published_policy_check" CHECK (("assignment_items"."published_policy_mode" = 'any' AND "assignment_items"."published_required_version_id" IS NULL) OR
    ("assignment_items"."published_policy_mode" = 'exact' AND "assignment_items"."published_required_version_id" IS NOT NULL)),
	CONSTRAINT "assignment_items_order_check" CHECK ("assignment_items"."sort_order" >= 0 AND "assignment_items"."policy_revision" >= 0 AND "assignment_items"."published_policy_revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "assignment_progress" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"assignment_id" text NOT NULL,
	"item_id" text NOT NULL,
	"user_id" text NOT NULL,
	"scope" text NOT NULL,
	"status" text NOT NULL,
	"score" integer,
	"accepted" boolean DEFAULT false NOT NULL,
	"source_submission_id" text,
	"source_kind" text,
	"source_attempt_id" text,
	"evaluated_version_id" text,
	"accepted_attempt_id" text,
	"policy_revision" integer DEFAULT 0 NOT NULL,
	"projection_revision" bigint DEFAULT 0 NOT NULL,
	"late" boolean DEFAULT false NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "assignment_progress_cell_unique" UNIQUE("item_id","user_id","scope"),
	CONSTRAINT "assignment_progress_scope_check" CHECK ("assignment_progress"."scope" IN ('on_time', 'current')),
	CONSTRAINT "assignment_progress_status_check" CHECK ("assignment_progress"."status" IN ('not_started', 'judging', 'below_target', 'achieved', 'unavailable')),
	CONSTRAINT "assignment_progress_score_check" CHECK ("assignment_progress"."score" IS NULL OR "assignment_progress"."score" BETWEEN 0 AND 10000)
);
--> statement-breakpoint
CREATE TABLE "assignment_recipients" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"classroom_id" text NOT NULL,
	"assignment_id" text NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"added_by" text NOT NULL,
	"joined_at" text NOT NULL,
	"left_at" text,
	"credit_intervals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "assignment_recipients_user_unique" UNIQUE("assignment_id","user_id"),
	CONSTRAINT "assignment_recipients_target_unique" UNIQUE("domain_id","assignment_id","user_id"),
	CONSTRAINT "assignment_recipients_status_check" CHECK ("assignment_recipients"."status" IN ('active', 'historical')),
	CONSTRAINT "assignment_recipients_added_by_check" CHECK ("assignment_recipients"."added_by" IN ('initial', 'automatic', 'manual'))
);
--> statement-breakpoint
CREATE TABLE "assignments" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"classroom_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"publish_at" text,
	"scheduled_by" text,
	"deadline_at" text,
	"published_at" text,
	"ended_at" text,
	"archived_at" text,
	"include_previous_submissions" boolean DEFAULT false NOT NULL,
	"target_student_ids" jsonb,
	"source_training_id" text,
	"source_training_rule" jsonb,
	"source_assignment_id" text,
	"source_contest_id" text,
	"publish_error" text,
	"created_by" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "assignments_domain_id_unique" UNIQUE("domain_id","id"),
	CONSTRAINT "assignments_class_domain_unique" UNIQUE("domain_id","id","classroom_id"),
	CONSTRAINT "assignments_state_check" CHECK ("assignments"."state" IN ('draft', 'scheduled', 'published', 'archived')),
	CONSTRAINT "assignments_revision_check" CHECK ("assignments"."revision" >= 0),
	CONSTRAINT "assignments_schedule_check" CHECK ("assignments"."state" <> 'scheduled' OR ("assignments"."publish_at" IS NOT NULL AND "assignments"."scheduled_by" IS NOT NULL)),
	CONSTRAINT "assignments_publish_check" CHECK ("assignments"."state" <> 'published' OR "assignments"."published_at" IS NOT NULL)
);
--> statement-breakpoint
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
	"archived_at" text,
	"primary_coach_id" text NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "classrooms_domain_id_unique" UNIQUE("domain_id","id"),
	CONSTRAINT "classrooms_status_check" CHECK ("classrooms"."status" IN ('active', 'archived')),
	CONSTRAINT "classrooms_revision_check" CHECK ("classrooms"."revision" >= 0)
);
--> statement-breakpoint
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
	"classroom_id" text,
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
CREATE TABLE "domain_llm_settings" (
	"domain_id" text PRIMARY KEY NOT NULL,
	"provider_id" text,
	"model" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "domain_llm_settings_revision_check" CHECK ("domain_llm_settings"."revision" >= 1),
	CONSTRAINT "domain_llm_settings_selection_check" CHECK (("domain_llm_settings"."provider_id" IS NULL AND "domain_llm_settings"."model" IS NULL) OR ("domain_llm_settings"."provider_id" IS NOT NULL AND "domain_llm_settings"."model" IS NOT NULL AND length(trim("domain_llm_settings"."provider_id")) > 0 AND length(trim("domain_llm_settings"."model")) > 0))
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
CREATE TABLE "domain_problem_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"problem_id" text NOT NULL,
	"kind" text NOT NULL,
	"visibility" text DEFAULT 'members' NOT NULL,
	"effective_version_mode" text DEFAULT 'any' NOT NULL,
	"required_version_id" text,
	"revision" integer DEFAULT 0 NOT NULL,
	"disabled_at" text,
	"created_by" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "domain_problem_bindings_identity_unique" UNIQUE("domain_id","problem_id"),
	CONSTRAINT "domain_problem_bindings_domain_id_unique" UNIQUE("domain_id","id"),
	CONSTRAINT "domain_problem_bindings_id_problem_unique" UNIQUE("id","problem_id"),
	CONSTRAINT "domain_problem_bindings_kind_check" CHECK ("domain_problem_bindings"."kind" IN ('owned', 'shared')),
	CONSTRAINT "domain_problem_bindings_visibility_check" CHECK ("domain_problem_bindings"."visibility" IN ('public', 'members')),
	CONSTRAINT "domain_problem_bindings_policy_check" CHECK (("domain_problem_bindings"."effective_version_mode" = 'any' AND "domain_problem_bindings"."required_version_id" IS NULL) OR ("domain_problem_bindings"."effective_version_mode" = 'exact' AND "domain_problem_bindings"."required_version_id" IS NOT NULL)),
	CONSTRAINT "domain_problem_bindings_revision_check" CHECK ("domain_problem_bindings"."revision" >= 0)
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
CREATE TABLE "domain_storage_objects" (
	"domain_id" text NOT NULL,
	"storage_url" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "domain_storage_objects_domain_id_storage_url_pk" PRIMARY KEY("domain_id","storage_url"),
	CONSTRAINT "domain_storage_objects_size_check" CHECK ("domain_storage_objects"."byte_size" >= 0)
);
--> statement-breakpoint
CREATE TABLE "domain_storage_uploads" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"state" text DEFAULT 'reserved' NOT NULL,
	"storage_url" text,
	"created_at" text NOT NULL,
	"expires_at" text NOT NULL,
	"finished_at" text,
	CONSTRAINT "domain_storage_uploads_size_check" CHECK ("domain_storage_uploads"."byte_size" >= 0),
	CONSTRAINT "domain_storage_uploads_state_check" CHECK ("domain_storage_uploads"."state" IN ('reserved', 'settled', 'released')),
	CONSTRAINT "domain_storage_uploads_result_check" CHECK (("domain_storage_uploads"."state" = 'settled' AND "domain_storage_uploads"."storage_url" IS NOT NULL AND "domain_storage_uploads"."finished_at" IS NOT NULL) OR ("domain_storage_uploads"."state" = 'released' AND "domain_storage_uploads"."finished_at" IS NOT NULL) OR ("domain_storage_uploads"."state" = 'reserved' AND "domain_storage_uploads"."finished_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "domain_training_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"training_id" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" text NOT NULL,
	"disabled_at" text,
	CONSTRAINT "domain_training_bindings_identity_unique" UNIQUE("domain_id","training_id")
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
CREATE TABLE "education_disabled_intervals" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text,
	"started_at" text NOT NULL,
	"ended_at" text,
	"reason" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "education_notification_emails" (
	"notification_id" text PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" text NOT NULL,
	"lease_token" text,
	"leased_until" text,
	"completed_at" text,
	"last_error" text,
	CONSTRAINT "education_notification_emails_state_check" CHECK ("education_notification_emails"."state" IN ('pending', 'sent', 'skipped')),
	CONSTRAINT "education_notification_emails_attempts_check" CHECK ("education_notification_emails"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "education_notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"assignment_id" text NOT NULL,
	"user_id" text NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"feedback_id" text,
	"help_id" text,
	"reply_id" text,
	"created_at" text NOT NULL,
	"read_at" text,
	CONSTRAINT "education_notifications_delivery_unique" UNIQUE("event_id","user_id"),
	CONSTRAINT "education_notifications_type_check" CHECK ("education_notifications"."type" IN ('assignment','assignment_changed','resource_unavailable','feedback','help','help_reply')),
	CONSTRAINT "education_notifications_source_check" CHECK (
    ("education_notifications"."type" IN ('assignment','assignment_changed','resource_unavailable') AND "education_notifications"."feedback_id" IS NULL AND "education_notifications"."help_id" IS NULL AND "education_notifications"."reply_id" IS NULL)
    OR ("education_notifications"."type" = 'feedback' AND "education_notifications"."feedback_id" IS NOT NULL AND "education_notifications"."help_id" IS NULL AND "education_notifications"."reply_id" IS NULL)
    OR ("education_notifications"."type" = 'help' AND "education_notifications"."feedback_id" IS NULL AND "education_notifications"."help_id" IS NOT NULL AND "education_notifications"."reply_id" IS NULL)
    OR ("education_notifications"."type" = 'help_reply' AND "education_notifications"."feedback_id" IS NULL AND "education_notifications"."help_id" IS NOT NULL AND "education_notifications"."reply_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "education_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"operation" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "education_operations_key_unique" UNIQUE("domain_id","actor_id","operation","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "education_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"event_type" text NOT NULL,
	"user_id" text,
	"problem_id" text,
	"classroom_id" text,
	"assignment_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" text NOT NULL,
	"available_at" text NOT NULL,
	"leased_until" text,
	"lease_token" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"processed_at" text,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "problem_binding_history" (
	"id" text PRIMARY KEY NOT NULL,
	"binding_id" text NOT NULL,
	"problem_id" text NOT NULL,
	"revision" integer NOT NULL,
	"effective_version_mode" text NOT NULL,
	"required_version_id" text,
	"answer_version_id" text,
	"disabled_at" text,
	"actor_id" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "problem_binding_history_revision_unique" UNIQUE("binding_id","revision"),
	CONSTRAINT "problem_binding_history_policy_check" CHECK (("problem_binding_history"."effective_version_mode" = 'any' AND "problem_binding_history"."required_version_id" IS NULL) OR ("problem_binding_history"."effective_version_mode" = 'exact' AND "problem_binding_history"."required_version_id" IS NOT NULL)),
	CONSTRAINT "problem_binding_history_revision_check" CHECK ("problem_binding_history"."revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "problem_share_settings" (
	"problem_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"scope" text DEFAULT 'all' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "problem_share_settings_scope_check" CHECK ("problem_share_settings"."scope" IN ('all', 'selected')),
	CONSTRAINT "problem_share_settings_revision_check" CHECK ("problem_share_settings"."revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "problem_share_targets" (
	"problem_id" text NOT NULL,
	"domain_id" text NOT NULL,
	CONSTRAINT "problem_share_targets_problem_id_domain_id_pk" PRIMARY KEY("problem_id","domain_id")
);
--> statement-breakpoint
CREATE TABLE "submission_annotations" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"classroom_id" text NOT NULL,
	"submission_id" text NOT NULL,
	"user_id" text NOT NULL,
	"author_id" text NOT NULL,
	"file_name" text NOT NULL,
	"source_hash" text NOT NULL,
	"start_line" integer NOT NULL,
	"end_line" integer NOT NULL,
	"body" text NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"deleted_at" text,
	CONSTRAINT "submission_annotations_lines_check" CHECK ("submission_annotations"."start_line" >= 1 AND "submission_annotations"."end_line" >= "submission_annotations"."start_line"),
	CONSTRAINT "submission_annotations_hash_check" CHECK ("submission_annotations"."source_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "submission_annotations_body_check" CHECK (char_length("submission_annotations"."body") BETWEEN 1 AND 30000),
	CONSTRAINT "submission_annotations_revision_check" CHECK ("submission_annotations"."revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "training_share_settings" (
	"training_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"scope" text DEFAULT 'all' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "training_share_settings_scope_check" CHECK ("training_share_settings"."scope" IN ('all', 'selected')),
	CONSTRAINT "training_share_settings_revision_check" CHECK ("training_share_settings"."revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "training_share_targets" (
	"training_id" text NOT NULL,
	"domain_id" text NOT NULL,
	CONSTRAINT "training_share_targets_training_id_domain_id_pk" PRIMARY KEY("training_id","domain_id")
);
--> statement-breakpoint
CREATE TABLE "user_workspace_preferences" (
	"user_id" text PRIMARY KEY NOT NULL,
	"last_domain_id" text,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "community_boards" DROP CONSTRAINT "community_boards_slug_unique";
--> statement-breakpoint
ALTER TABLE "problems" DROP CONSTRAINT "problems_type_number_unique";
--> statement-breakpoint
ALTER TABLE "submission_jobs" DROP CONSTRAINT "submission_jobs_actor_kind_key_unique";
--> statement-breakpoint
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_action_check";
--> statement-breakpoint
ALTER TABLE "contests" DROP CONSTRAINT "contests_type_check";
--> statement-breakpoint
ALTER TABLE "problems" DROP CONSTRAINT "problems_type_check";
--> statement-breakpoint
ALTER TABLE "problems" DROP CONSTRAINT "problems_p_visibility_check";
--> statement-breakpoint
ALTER TABLE llm_model_aliases DROP CONSTRAINT llm_model_aliases_pkey;
--> statement-breakpoint
ALTER TABLE "community_boards" ADD COLUMN "domain_id" text;
--> statement-breakpoint
ALTER TABLE "community_boards" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "community_comments" ADD COLUMN "domain_id" text;
--> statement-breakpoint
ALTER TABLE "community_moderation_actions" ADD COLUMN "domain_id" text;
--> statement-breakpoint
ALTER TABLE "community_notifications" ADD COLUMN "domain_id" text;
--> statement-breakpoint
ALTER TABLE "community_posts" ADD COLUMN "domain_id" text;
--> statement-breakpoint
ALTER TABLE "community_posts" ADD COLUMN "domain_problem_binding_id" text;
--> statement-breakpoint
ALTER TABLE "community_reports" ADD COLUMN "domain_id" text;
--> statement-breakpoint
ALTER TABLE "community_sanctions" ADD COLUMN "domain_id" text;
--> statement-breakpoint
ALTER TABLE "contest_problems" ADD COLUMN "domain_id" text;
--> statement-breakpoint
ALTER TABLE "contest_problems" ADD COLUMN "domain_problem_binding_id" text;
--> statement-breakpoint
ALTER TABLE "contests" ADD COLUMN "domain_id" text;
--> statement-breakpoint
ALTER TABLE "contests" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "llm_model_aliases" ADD COLUMN "domain_id" text;
--> statement-breakpoint
ALTER TABLE "llm_model_aliases" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "objective_submissions" ADD COLUMN "receipt_sequence" bigint DEFAULT nextval('submission_receipt_sequence') NOT NULL;
--> statement-breakpoint
ALTER TABLE "objective_submissions" ADD COLUMN "domain_id" text;
--> statement-breakpoint
ALTER TABLE "objective_submissions" ADD COLUMN "domain_problem_binding_id" text;
--> statement-breakpoint
ALTER TABLE "objective_submissions" ADD COLUMN "assignment_id" text;
--> statement-breakpoint
ALTER TABLE "objective_submissions" ADD COLUMN "assignment_item_id" text;
--> statement-breakpoint
ALTER TABLE "problems" ADD COLUMN "domain_id" text;
--> statement-breakpoint
ALTER TABLE "search_entries" ADD COLUMN "domain_id" text;
--> statement-breakpoint
ALTER TABLE "self_tests" ADD COLUMN "domain_id" text;
--> statement-breakpoint
ALTER TABLE "self_tests" ADD COLUMN "domain_problem_binding_id" text;
--> statement-breakpoint
ALTER TABLE "self_tests" ADD COLUMN "assignment_id" text;
--> statement-breakpoint
ALTER TABLE "self_tests" ADD COLUMN "assignment_item_id" text;
--> statement-breakpoint
ALTER TABLE "submission_job_items" ADD COLUMN "domain_id" text;
--> statement-breakpoint
ALTER TABLE "submission_job_items" ADD COLUMN "domain_problem_binding_id" text;
--> statement-breakpoint
ALTER TABLE "submission_jobs" ADD COLUMN "domain_id" text;
--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "receipt_sequence" bigint DEFAULT nextval('submission_receipt_sequence') NOT NULL;
--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "domain_id" text;
--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "domain_problem_binding_id" text;
--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "assignment_id" text;
--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "assignment_item_id" text;
--> statement-breakpoint
ALTER TABLE "trainings" ADD COLUMN "domain_id" text;
--> statement-breakpoint
ALTER TABLE "trainings" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- BEGIN DEFAULT WORKSPACE BACKFILL
-- 完成扩展阶段的存量回填。空库留给既有初始化流程，不创建可登录账号。
WITH initialized AS (
  INSERT INTO domains (id, slug, name, owner_id, preset, configuration, created_at, updated_at)
  SELECT '00000000-0000-4000-8000-000000000001', 'main', 'Neuro OJ', u.id, 'community',
    '{"access":"public","discoverable":true,"join_policy":"open","features":{"community":true,"classroom":false,"assignment":false,"analytics":false},"homepage":"community"}'::jsonb,
    to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  FROM users u WHERE u.id = '0'
  ON CONFLICT (slug) DO NOTHING RETURNING id, owner_id, created_at
), members AS (
  INSERT INTO domain_memberships (id, domain_id, user_id, joined_at)
  SELECT gen_random_uuid()::text, initialized.id, u.id, initialized.created_at
  FROM initialized CROSS JOIN users u WHERE u.deleted_at IS NULL
  RETURNING id, user_id
)
INSERT INTO domain_member_roles (membership_id, role)
SELECT id, CASE WHEN user_id = '0' THEN 'owner' ELSE 'member' END FROM members;--> statement-breakpoint
INSERT INTO domain_limits (domain_id)
SELECT id FROM domains WHERE id = '00000000-0000-4000-8000-000000000001'
ON CONFLICT (domain_id) DO NOTHING;--> statement-breakpoint
UPDATE problems SET domain_id = '00000000-0000-4000-8000-000000000001' WHERE domain_id IS NULL;--> statement-breakpoint
UPDATE trainings SET domain_id = '00000000-0000-4000-8000-000000000001' WHERE domain_id IS NULL;--> statement-breakpoint
WITH bound AS (
  INSERT INTO domain_problem_bindings (id, domain_id, problem_id, kind, visibility,
    effective_version_mode, required_version_id, revision, created_by, created_at, updated_at)
  SELECT gen_random_uuid()::text, p.domain_id, p.id, 'owned',
    CASE WHEN p.visibility = 'public' THEN 'public' ELSE 'members' END,
    p.effective_version_mode, p.required_version_id, p.effective_policy_revision,
    d.owner_id, p.created_at, p.updated_at
  FROM problems p JOIN domains d ON d.id = p.domain_id
  ON CONFLICT (domain_id, problem_id) DO NOTHING RETURNING *
)
INSERT INTO problem_binding_history (id, binding_id, problem_id, revision,
  effective_version_mode, required_version_id, answer_version_id, actor_id, reason, created_at)
SELECT gen_random_uuid()::text, b.id, b.problem_id, b.revision, b.effective_version_mode,
  b.required_version_id, COALESCE(b.required_version_id, p.latest_version_id),
  b.created_by, '存量源题归属收缩迁移', b.updated_at
FROM bound b JOIN problems p ON p.id = b.problem_id;--> statement-breakpoint
INSERT INTO domain_resource_counters (domain_id, resource, used)
SELECT d.id, resource, CASE resource
    WHEN 'members' THEN (SELECT count(*) FROM domain_memberships m WHERE m.domain_id = d.id AND m.status = 'active')
    WHEN 'problems' THEN (SELECT count(*) FROM domain_problem_bindings b WHERE b.domain_id = d.id)
    ELSE 0 END
FROM domains d CROSS JOIN (VALUES ('members'), ('problems'), ('storage_bytes')) AS resources(resource)
WHERE d.id = '00000000-0000-4000-8000-000000000001'
ON CONFLICT (domain_id, resource) DO NOTHING;--> statement-breakpoint
UPDATE domains SET next_problem_number = GREATEST(next_problem_number,
  COALESCE((SELECT max(p.number) + 1 FROM problems p WHERE p.domain_id = domains.id), 1001))
WHERE id = '00000000-0000-4000-8000-000000000001';
--> statement-breakpoint
UPDATE llm_model_aliases SET domain_id = '00000000-0000-4000-8000-000000000001' WHERE domain_id IS NULL;
--> statement-breakpoint
-- 旧默认执行配置只归入 main；重复初始化不能覆盖域管理员已经选择的模型。
INSERT INTO domain_llm_settings (domain_id, provider_id, model, revision, updated_at)
SELECT d.id, p.value::jsonb #>> '{}', m.value::jsonb #>> '{}', 1, CURRENT_TIMESTAMP::text
FROM domains d
JOIN system_settings p ON p.key = 'llm_default_provider_id'
JOIN system_settings m ON m.key = 'llm_default_model'
WHERE d.slug = 'main'
  AND jsonb_typeof(p.value::jsonb) = 'string' AND jsonb_typeof(m.value::jsonb) = 'string'
  AND length(trim(p.value::jsonb #>> '{}')) > 0 AND length(trim(m.value::jsonb #>> '{}')) > 0
ON CONFLICT (domain_id) DO NOTHING;

--> statement-breakpoint
-- BEGIN EXECUTION WORKSPACE BACKFILL

UPDATE submissions SET domain_id = '00000000-0000-4000-8000-000000000001' WHERE domain_id IS NULL;--> statement-breakpoint
UPDATE objective_submissions SET domain_id = '00000000-0000-4000-8000-000000000001' WHERE domain_id IS NULL;--> statement-breakpoint
UPDATE self_tests SET domain_id = '00000000-0000-4000-8000-000000000001' WHERE domain_id IS NULL;--> statement-breakpoint
UPDATE submission_jobs SET domain_id = '00000000-0000-4000-8000-000000000001' WHERE domain_id IS NULL;--> statement-breakpoint
UPDATE submission_job_items item SET domain_id = job.domain_id
FROM submission_jobs job WHERE item.job_id = job.id AND item.domain_id IS NULL;--> statement-breakpoint
UPDATE submissions s SET domain_problem_binding_id = b.id
FROM domain_problem_bindings b WHERE s.domain_problem_binding_id IS NULL
  AND b.domain_id = s.domain_id AND b.problem_id = s.problem_id;--> statement-breakpoint
UPDATE objective_submissions s SET domain_problem_binding_id = b.id
FROM domain_problem_bindings b WHERE s.domain_problem_binding_id IS NULL
  AND b.domain_id = s.domain_id AND b.problem_id = s.paper_id;--> statement-breakpoint
UPDATE self_tests s SET domain_problem_binding_id = b.id
FROM domain_problem_bindings b WHERE s.domain_problem_binding_id IS NULL
  AND b.domain_id = s.domain_id AND b.problem_id = s.problem_id;--> statement-breakpoint
UPDATE submission_job_items item SET domain_problem_binding_id = b.id
FROM domain_problem_bindings b WHERE item.domain_problem_binding_id IS NULL
  AND b.domain_id = item.domain_id AND b.problem_id = item.problem_id;
--> statement-breakpoint
-- END EXECUTION WORKSPACE BACKFILL
-- 升级前全部内容处于单一实例题库；保留已清除目标指针的历史社区记录。
UPDATE community_posts SET domain_id = '00000000-0000-4000-8000-000000000001' WHERE domain_id IS NULL;

--> statement-breakpoint
UPDATE community_moderation_actions SET domain_id = '00000000-0000-4000-8000-000000000001'
WHERE domain_id IS NULL AND target_type NOT IN ('message', 'user_ban');

--> statement-breakpoint
UPDATE community_notifications SET domain_id = '00000000-0000-4000-8000-000000000001'
WHERE domain_id IS NULL AND type IN ('reply', 'like', 'moderation', 'clarification');
--> statement-breakpoint
-- BEGIN COMMUNITY WORKSPACE BACKFILL
-- 原单域社区的板块与处罚在扩展迁移执行时可能尚未初始化 main。
-- 只对历史空值完成该已知归属；既有显式域不改写。
UPDATE community_boards SET domain_id = '00000000-0000-4000-8000-000000000001'
WHERE domain_id IS NULL;
--> statement-breakpoint

UPDATE community_sanctions SET domain_id = '00000000-0000-4000-8000-000000000001'
WHERE domain_id IS NULL;
--> statement-breakpoint

UPDATE community_posts p SET domain_id = b.domain_id
FROM community_boards b WHERE p.board_id = b.id AND p.domain_id IS NULL;
--> statement-breakpoint

UPDATE community_posts p SET domain_id = b.domain_id
FROM domain_problem_bindings b WHERE p.domain_problem_binding_id = b.id AND p.domain_id IS NULL;
--> statement-breakpoint

-- 未绑定的旧题解仅能是原默认题库；其他源域不能推导使用域。
UPDATE community_posts p SET domain_id = '00000000-0000-4000-8000-000000000001'
WHERE p.domain_id IS NULL AND (p.type = 'moment' OR (p.type = 'solution' AND EXISTS (
  SELECT 1 FROM problems source WHERE source.id = p.problem_id
    AND source.domain_id = '00000000-0000-4000-8000-000000000001'
)));
--> statement-breakpoint

UPDATE community_posts p SET domain_problem_binding_id = b.id
FROM domain_problem_bindings b WHERE p.type = 'solution'
  AND p.domain_problem_binding_id IS NULL AND b.domain_id = p.domain_id
  AND b.problem_id = p.problem_id;
--> statement-breakpoint

UPDATE community_comments c SET domain_id = p.domain_id
FROM community_posts p WHERE c.post_id = p.id AND c.domain_id IS NULL;
--> statement-breakpoint

UPDATE community_reports r SET domain_id = p.domain_id
FROM community_posts p WHERE r.post_id = p.id AND r.domain_id IS NULL;
--> statement-breakpoint

UPDATE community_reports r SET domain_id = c.domain_id
FROM community_comments c WHERE r.comment_id = c.id AND r.domain_id IS NULL;
--> statement-breakpoint

UPDATE community_moderation_actions a SET domain_id = p.domain_id
FROM community_posts p WHERE a.target_type = 'post' AND a.target_id = p.id
  AND a.domain_id IS NULL;
--> statement-breakpoint

UPDATE community_moderation_actions a SET domain_id = c.domain_id
FROM community_comments c WHERE a.target_type = 'comment' AND a.target_id = c.id
  AND a.domain_id IS NULL;
--> statement-breakpoint

UPDATE community_notifications n SET domain_id = p.domain_id
FROM community_posts p WHERE n.post_id = p.id AND n.domain_id IS NULL;
--> statement-breakpoint

UPDATE community_notifications n SET domain_id = c.domain_id
FROM community_comments c WHERE n.comment_id = c.id AND n.domain_id IS NULL;
--> statement-breakpoint

UPDATE community_notifications n SET domain_id = r.domain_id
FROM community_reports r WHERE n.type = 'report' AND n.data->>'report_id' = r.id
  AND n.domain_id IS NULL;
--> statement-breakpoint

UPDATE community_notifications n SET domain_id = c.domain_id
FROM contests c WHERE n.type = 'clarification' AND n.data->>'contest_id' = c.id
  AND n.domain_id IS NULL;
--> statement-breakpoint
-- END COMMUNITY WORKSPACE BACKFILL
UPDATE search_entries e SET domain_id = p.domain_id FROM problems p WHERE e.entity_type = 'problem' AND e.entity_id = p.id;

--> statement-breakpoint
UPDATE search_entries e SET domain_id = p.domain_id FROM community_posts p WHERE e.entity_type = 'community_post' AND e.entity_id = p.id;

--> statement-breakpoint
UPDATE search_entries e SET domain_id = c.domain_id FROM community_comments c WHERE e.entity_type = 'community_comment' AND e.entity_id = c.id;

--> statement-breakpoint
UPDATE search_entries e SET domain_id = s.domain_id FROM submissions s WHERE e.entity_type = 'submission' AND e.entity_id = s.id;
--> statement-breakpoint
ALTER TABLE "community_boards" ALTER COLUMN "domain_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "community_comments" ALTER COLUMN "domain_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "community_posts" ALTER COLUMN "domain_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "community_sanctions" ALTER COLUMN "domain_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "contest_problems" ALTER COLUMN "domain_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "contest_problems" ALTER COLUMN "domain_problem_binding_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "contests" ALTER COLUMN "domain_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "llm_model_aliases" ALTER COLUMN "domain_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "objective_submissions" ALTER COLUMN "domain_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "objective_submissions" ALTER COLUMN "domain_problem_binding_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "problems" ALTER COLUMN "domain_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "self_tests" ALTER COLUMN "domain_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "self_tests" ALTER COLUMN "domain_problem_binding_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "submission_job_items" ALTER COLUMN "domain_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "submission_jobs" ALTER COLUMN "domain_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "submissions" ALTER COLUMN "domain_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "submissions" ALTER COLUMN "domain_problem_binding_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "trainings" ALTER COLUMN "domain_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "llm_model_aliases" ADD CONSTRAINT "llm_model_aliases_domain_id_alias_pk" PRIMARY KEY("domain_id","alias");
--> statement-breakpoint
ALTER TABLE "community_boards" ADD CONSTRAINT "community_boards_domain_id_unique" UNIQUE("id","domain_id");
--> statement-breakpoint
ALTER TABLE "community_boards" ADD CONSTRAINT "community_boards_domain_slug_unique" UNIQUE("domain_id","slug");
--> statement-breakpoint
ALTER TABLE "community_comments" ADD CONSTRAINT "community_comments_domain_id_unique" UNIQUE("id","domain_id");
--> statement-breakpoint
ALTER TABLE "community_comments" ADD CONSTRAINT "community_comments_post_domain_unique" UNIQUE("id","post_id","domain_id");
--> statement-breakpoint
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_domain_id_unique" UNIQUE("id","domain_id");
--> statement-breakpoint
ALTER TABLE "contests" ADD CONSTRAINT "contests_domain_id_unique" UNIQUE("domain_id","id");
--> statement-breakpoint
ALTER TABLE "problems" ADD CONSTRAINT "problems_domain_id_id_unique" UNIQUE("domain_id","id");
--> statement-breakpoint
ALTER TABLE "problems" ADD CONSTRAINT "problems_domain_number_unique" UNIQUE("domain_id","number");
--> statement-breakpoint
ALTER TABLE "submission_jobs" ADD CONSTRAINT "submission_jobs_domain_id_unique" UNIQUE("domain_id","id");
--> statement-breakpoint
ALTER TABLE "submission_jobs" ADD CONSTRAINT "submission_jobs_domain_actor_kind_key_unique" UNIQUE("domain_id","actor_id","kind","idempotency_key");
--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_teaching_source_unique" UNIQUE("domain_id","id","user_id");
--> statement-breakpoint
ALTER TABLE "assignment_feedback" ADD CONSTRAINT "assignment_feedback_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assignment_feedback" ADD CONSTRAINT "assignment_feedback_assignment_fk" FOREIGN KEY ("domain_id","assignment_id") REFERENCES "assignments"("domain_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assignment_feedback" ADD CONSTRAINT "assignment_feedback_recipient_fk" FOREIGN KEY ("domain_id","assignment_id","target_user_id") REFERENCES "assignment_recipients"("domain_id","assignment_id","user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assignment_help_replies" ADD CONSTRAINT "assignment_help_replies_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assignment_help_replies" ADD CONSTRAINT "assignment_help_replies_request_fk" FOREIGN KEY ("domain_id","assignment_id","help_id") REFERENCES "assignment_help_requests"("domain_id","assignment_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assignment_help_requests" ADD CONSTRAINT "assignment_help_requests_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "submissions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assignment_help_requests" ADD CONSTRAINT "assignment_help_requests_objective_submission_id_objective_submissions_id_fk" FOREIGN KEY ("objective_submission_id") REFERENCES "objective_submissions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assignment_help_requests" ADD CONSTRAINT "assignment_help_requests_handled_by_users_id_fk" FOREIGN KEY ("handled_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assignment_help_requests" ADD CONSTRAINT "assignment_help_requests_recipient_fk" FOREIGN KEY ("domain_id","assignment_id","user_id") REFERENCES "assignment_recipients"("domain_id","assignment_id","user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assignment_help_requests" ADD CONSTRAINT "assignment_help_requests_item_fk" FOREIGN KEY ("domain_id","assignment_id","item_id") REFERENCES "assignment_items"("domain_id","assignment_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assignment_item_history" ADD CONSTRAINT "assignment_item_history_binding_history_id_problem_binding_history_id_fk" FOREIGN KEY ("binding_history_id") REFERENCES "problem_binding_history"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assignment_item_history" ADD CONSTRAINT "assignment_item_history_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assignment_item_history" ADD CONSTRAINT "assignment_item_history_item_domain_fk" FOREIGN KEY ("domain_id","item_id") REFERENCES "assignment_items"("domain_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assignment_item_history" ADD CONSTRAINT "assignment_item_history_item_problem_fk" FOREIGN KEY ("item_id","problem_id") REFERENCES "assignment_items"("id","problem_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assignment_item_history" ADD CONSTRAINT "assignment_item_history_answer_version_fk" FOREIGN KEY ("problem_id","answer_version_id") REFERENCES "problem_versions"("problem_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assignment_item_history" ADD CONSTRAINT "assignment_item_history_required_version_fk" FOREIGN KEY ("problem_id","required_version_id") REFERENCES "problem_versions"("problem_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assignment_items" ADD CONSTRAINT "assignment_items_problem_id_problems_id_fk" FOREIGN KEY ("problem_id") REFERENCES "problems"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assignment_items" ADD CONSTRAINT "assignment_items_assignment_domain_fk" FOREIGN KEY ("domain_id","assignment_id") REFERENCES "assignments"("domain_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assignment_items" ADD CONSTRAINT "assignment_items_binding_domain_fk" FOREIGN KEY ("domain_id","binding_id") REFERENCES "domain_problem_bindings"("domain_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assignment_items" ADD CONSTRAINT "assignment_items_binding_problem_fk" FOREIGN KEY ("binding_id","problem_id") REFERENCES "domain_problem_bindings"("id","problem_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assignment_items" ADD CONSTRAINT "assignment_items_published_version_fk" FOREIGN KEY ("problem_id","published_version_id") REFERENCES "problem_versions"("problem_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assignment_items" ADD CONSTRAINT "assignment_items_required_version_fk" FOREIGN KEY ("problem_id","published_required_version_id") REFERENCES "problem_versions"("problem_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assignment_items" ADD CONSTRAINT "assignment_items_answer_version_fk" FOREIGN KEY ("problem_id","answer_version_id") REFERENCES "problem_versions"("problem_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assignment_progress" ADD CONSTRAINT "assignment_progress_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assignment_progress" ADD CONSTRAINT "assignment_progress_source_attempt_id_evaluation_attempts_id_fk" FOREIGN KEY ("source_attempt_id") REFERENCES "evaluation_attempts"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assignment_progress" ADD CONSTRAINT "assignment_progress_evaluated_version_id_problem_versions_id_fk" FOREIGN KEY ("evaluated_version_id") REFERENCES "problem_versions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assignment_progress" ADD CONSTRAINT "assignment_progress_accepted_attempt_id_evaluation_attempts_id_fk" FOREIGN KEY ("accepted_attempt_id") REFERENCES "evaluation_attempts"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assignment_progress" ADD CONSTRAINT "assignment_progress_item_assignment_fk" FOREIGN KEY ("domain_id","assignment_id","item_id") REFERENCES "assignment_items"("domain_id","assignment_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assignment_progress" ADD CONSTRAINT "assignment_progress_recipient_fk" FOREIGN KEY ("assignment_id","user_id") REFERENCES "assignment_recipients"("assignment_id","user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assignment_recipients" ADD CONSTRAINT "assignment_recipients_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assignment_recipients" ADD CONSTRAINT "assignment_recipients_assignment_class_fk" FOREIGN KEY ("domain_id","assignment_id","classroom_id") REFERENCES "assignments"("domain_id","id","classroom_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assignment_recipients" ADD CONSTRAINT "assignment_recipients_class_member_fk" FOREIGN KEY ("domain_id","classroom_id","user_id") REFERENCES "classroom_memberships"("domain_id","classroom_id","user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_scheduled_by_users_id_fk" FOREIGN KEY ("scheduled_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_source_training_id_trainings_id_fk" FOREIGN KEY ("source_training_id") REFERENCES "trainings"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_source_assignment_id_assignments_id_fk" FOREIGN KEY ("source_assignment_id") REFERENCES "assignments"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_classroom_domain_fk" FOREIGN KEY ("domain_id","classroom_id") REFERENCES "classrooms"("domain_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_source_contest_domain_fk" FOREIGN KEY ("domain_id","source_contest_id") REFERENCES "contests"("domain_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_source_assignment_domain_fk" FOREIGN KEY ("domain_id","source_assignment_id") REFERENCES "assignments"("domain_id","id") ON DELETE no action ON UPDATE no action;
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
ALTER TABLE "domain_creation_requests" ADD CONSTRAINT "domain_creation_requests_applicant_id_users_id_fk" FOREIGN KEY ("applicant_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "domain_creation_requests" ADD CONSTRAINT "domain_creation_requests_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "domain_creation_requests" ADD CONSTRAINT "domain_creation_requests_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "domain_feature_intervals" ADD CONSTRAINT "domain_feature_intervals_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "domain_invitations" ADD CONSTRAINT "domain_invitations_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "domain_invitations" ADD CONSTRAINT "domain_invitations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "domain_invitations" ADD CONSTRAINT "domain_invitations_classroom_domain_fk" FOREIGN KEY ("domain_id","classroom_id") REFERENCES "classrooms"("domain_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "domain_join_requests" ADD CONSTRAINT "domain_join_requests_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "domain_join_requests" ADD CONSTRAINT "domain_join_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "domain_join_requests" ADD CONSTRAINT "domain_join_requests_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "domain_limits" ADD CONSTRAINT "domain_limits_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "domain_llm_settings" ADD CONSTRAINT "domain_llm_settings_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "domain_member_roles" ADD CONSTRAINT "domain_member_roles_membership_id_domain_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "domain_memberships"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "domain_memberships" ADD CONSTRAINT "domain_memberships_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "domain_memberships" ADD CONSTRAINT "domain_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "domain_problem_bindings" ADD CONSTRAINT "domain_problem_bindings_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "domain_problem_bindings" ADD CONSTRAINT "domain_problem_bindings_problem_id_problems_id_fk" FOREIGN KEY ("problem_id") REFERENCES "problems"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "domain_problem_bindings" ADD CONSTRAINT "domain_problem_bindings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "domain_problem_bindings" ADD CONSTRAINT "domain_problem_bindings_required_version_fk" FOREIGN KEY ("problem_id","required_version_id") REFERENCES "problem_versions"("problem_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "domain_resource_counters" ADD CONSTRAINT "domain_resource_counters_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "domain_storage_objects" ADD CONSTRAINT "domain_storage_objects_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "domain_storage_objects" ADD CONSTRAINT "domain_storage_objects_storage_url_storage_objects_storage_url_fk" FOREIGN KEY ("storage_url") REFERENCES "storage_objects"("storage_url") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "domain_storage_uploads" ADD CONSTRAINT "domain_storage_uploads_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "domain_storage_uploads" ADD CONSTRAINT "domain_storage_uploads_storage_url_storage_objects_storage_url_fk" FOREIGN KEY ("storage_url") REFERENCES "storage_objects"("storage_url") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "domain_training_bindings" ADD CONSTRAINT "domain_training_bindings_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "domain_training_bindings" ADD CONSTRAINT "domain_training_bindings_training_id_trainings_id_fk" FOREIGN KEY ("training_id") REFERENCES "trainings"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "domain_training_bindings" ADD CONSTRAINT "domain_training_bindings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "education_disabled_intervals" ADD CONSTRAINT "education_disabled_intervals_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "education_notification_emails" ADD CONSTRAINT "education_notification_emails_notification_id_education_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "education_notifications"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "education_notifications" ADD CONSTRAINT "education_notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "education_notifications" ADD CONSTRAINT "education_notifications_event_id_education_outbox_id_fk" FOREIGN KEY ("event_id") REFERENCES "education_outbox"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "education_notifications" ADD CONSTRAINT "education_notifications_assignment_fk" FOREIGN KEY ("domain_id","assignment_id") REFERENCES "assignments"("domain_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "education_notifications" ADD CONSTRAINT "education_notifications_feedback_fk" FOREIGN KEY ("domain_id","assignment_id","feedback_id") REFERENCES "assignment_feedback"("domain_id","assignment_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "education_notifications" ADD CONSTRAINT "education_notifications_help_fk" FOREIGN KEY ("domain_id","assignment_id","help_id") REFERENCES "assignment_help_requests"("domain_id","assignment_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "education_notifications" ADD CONSTRAINT "education_notifications_reply_fk" FOREIGN KEY ("domain_id","assignment_id","reply_id") REFERENCES "assignment_help_replies"("domain_id","assignment_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "education_operations" ADD CONSTRAINT "education_operations_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "education_operations" ADD CONSTRAINT "education_operations_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "education_outbox" ADD CONSTRAINT "education_outbox_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "education_outbox" ADD CONSTRAINT "education_outbox_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "education_outbox" ADD CONSTRAINT "education_outbox_problem_id_problems_id_fk" FOREIGN KEY ("problem_id") REFERENCES "problems"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "education_outbox" ADD CONSTRAINT "education_outbox_classroom_domain_fk" FOREIGN KEY ("domain_id","classroom_id") REFERENCES "classrooms"("domain_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "education_outbox" ADD CONSTRAINT "education_outbox_assignment_domain_fk" FOREIGN KEY ("domain_id","assignment_id") REFERENCES "assignments"("domain_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "problem_binding_history" ADD CONSTRAINT "problem_binding_history_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "problem_binding_history" ADD CONSTRAINT "problem_binding_history_binding_fk" FOREIGN KEY ("binding_id","problem_id") REFERENCES "domain_problem_bindings"("id","problem_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "problem_binding_history" ADD CONSTRAINT "problem_binding_history_required_version_fk" FOREIGN KEY ("problem_id","required_version_id") REFERENCES "problem_versions"("problem_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "problem_binding_history" ADD CONSTRAINT "problem_binding_history_answer_version_fk" FOREIGN KEY ("problem_id","answer_version_id") REFERENCES "problem_versions"("problem_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "problem_share_settings" ADD CONSTRAINT "problem_share_settings_problem_id_problems_id_fk" FOREIGN KEY ("problem_id") REFERENCES "problems"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "problem_share_settings" ADD CONSTRAINT "problem_share_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "problem_share_targets" ADD CONSTRAINT "problem_share_targets_problem_id_problem_share_settings_problem_id_fk" FOREIGN KEY ("problem_id") REFERENCES "problem_share_settings"("problem_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "problem_share_targets" ADD CONSTRAINT "problem_share_targets_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "submission_annotations" ADD CONSTRAINT "submission_annotations_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "submission_annotations" ADD CONSTRAINT "submission_annotations_classroom_fk" FOREIGN KEY ("domain_id","classroom_id") REFERENCES "classrooms"("domain_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "submission_annotations" ADD CONSTRAINT "submission_annotations_source_fk" FOREIGN KEY ("domain_id","submission_id","user_id") REFERENCES "submissions"("domain_id","id","user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "training_share_settings" ADD CONSTRAINT "training_share_settings_training_id_trainings_id_fk" FOREIGN KEY ("training_id") REFERENCES "trainings"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "training_share_settings" ADD CONSTRAINT "training_share_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "training_share_targets" ADD CONSTRAINT "training_share_targets_training_id_training_share_settings_training_id_fk" FOREIGN KEY ("training_id") REFERENCES "training_share_settings"("training_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "training_share_targets" ADD CONSTRAINT "training_share_targets_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "user_workspace_preferences" ADD CONSTRAINT "user_workspace_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "user_workspace_preferences" ADD CONSTRAINT "user_workspace_preferences_last_domain_id_domains_id_fk" FOREIGN KEY ("last_domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "community_boards" ADD CONSTRAINT "community_boards_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "community_comments" ADD CONSTRAINT "community_comments_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "community_comments" ADD CONSTRAINT "community_comments_workspace_post_fk" FOREIGN KEY ("post_id","domain_id") REFERENCES "community_posts"("id","domain_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "community_comments" ADD CONSTRAINT "community_comments_workspace_parent_fk" FOREIGN KEY ("parent_id","post_id","domain_id") REFERENCES "community_comments"("id","post_id","domain_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "community_moderation_actions" ADD CONSTRAINT "community_moderation_actions_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "community_notifications" ADD CONSTRAINT "community_notifications_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "community_notifications" ADD CONSTRAINT "community_notifications_workspace_post_fk" FOREIGN KEY ("post_id","domain_id") REFERENCES "community_posts"("id","domain_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "community_notifications" ADD CONSTRAINT "community_notifications_workspace_comment_fk" FOREIGN KEY ("comment_id","domain_id") REFERENCES "community_comments"("id","domain_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_workspace_board_fk" FOREIGN KEY ("board_id","domain_id") REFERENCES "community_boards"("id","domain_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_workspace_binding_fk" FOREIGN KEY ("domain_problem_binding_id","domain_id") REFERENCES "domain_problem_bindings"("id","domain_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_binding_problem_fk" FOREIGN KEY ("domain_problem_binding_id","problem_id") REFERENCES "domain_problem_bindings"("id","problem_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "community_reports" ADD CONSTRAINT "community_reports_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "community_reports" ADD CONSTRAINT "community_reports_workspace_post_fk" FOREIGN KEY ("post_id","domain_id") REFERENCES "community_posts"("id","domain_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "community_reports" ADD CONSTRAINT "community_reports_workspace_comment_fk" FOREIGN KEY ("comment_id","domain_id") REFERENCES "community_comments"("id","domain_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "community_sanctions" ADD CONSTRAINT "community_sanctions_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "contest_problems" ADD CONSTRAINT "contest_problems_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "contest_problems" ADD CONSTRAINT "contest_problems_workspace_contest_fk" FOREIGN KEY ("domain_id","contest_id") REFERENCES "contests"("domain_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "contest_problems" ADD CONSTRAINT "contest_problems_workspace_binding_fk" FOREIGN KEY ("domain_id","domain_problem_binding_id") REFERENCES "domain_problem_bindings"("domain_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "contest_problems" ADD CONSTRAINT "contest_problems_binding_problem_fk" FOREIGN KEY ("domain_problem_binding_id","problem_id") REFERENCES "domain_problem_bindings"("id","problem_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "contests" ADD CONSTRAINT "contests_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "llm_model_aliases" ADD CONSTRAINT "llm_model_aliases_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "objective_submissions" ADD CONSTRAINT "objective_submissions_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "objective_submissions" ADD CONSTRAINT "objective_submissions_workspace_contest_fk" FOREIGN KEY ("domain_id","contest_id") REFERENCES "contests"("domain_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "objective_submissions" ADD CONSTRAINT "objective_submissions_assignment_origin_fk" FOREIGN KEY ("domain_id","assignment_id","assignment_item_id") REFERENCES "assignment_items"("domain_id","assignment_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "objective_submissions" ADD CONSTRAINT "objective_submissions_assignment_problem_fk" FOREIGN KEY ("assignment_item_id","paper_id") REFERENCES "assignment_items"("id","problem_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "objective_submissions" ADD CONSTRAINT "objective_submissions_assignment_domain_fk" FOREIGN KEY ("domain_id","assignment_id") REFERENCES "assignments"("domain_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "objective_submissions" ADD CONSTRAINT "objective_submissions_workspace_binding_fk" FOREIGN KEY ("domain_id","domain_problem_binding_id") REFERENCES "domain_problem_bindings"("domain_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "objective_submissions" ADD CONSTRAINT "objective_submissions_binding_problem_fk" FOREIGN KEY ("domain_problem_binding_id","paper_id") REFERENCES "domain_problem_bindings"("id","problem_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "problems" ADD CONSTRAINT "problems_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "search_entries" ADD CONSTRAINT "search_entries_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "self_tests" ADD CONSTRAINT "self_tests_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "self_tests" ADD CONSTRAINT "self_tests_assignment_origin_fk" FOREIGN KEY ("domain_id","assignment_id","assignment_item_id") REFERENCES "assignment_items"("domain_id","assignment_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "self_tests" ADD CONSTRAINT "self_tests_assignment_problem_fk" FOREIGN KEY ("assignment_item_id","problem_id") REFERENCES "assignment_items"("id","problem_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "self_tests" ADD CONSTRAINT "self_tests_assignment_domain_fk" FOREIGN KEY ("domain_id","assignment_id") REFERENCES "assignments"("domain_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "self_tests" ADD CONSTRAINT "self_tests_workspace_binding_fk" FOREIGN KEY ("domain_id","domain_problem_binding_id") REFERENCES "domain_problem_bindings"("domain_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "self_tests" ADD CONSTRAINT "self_tests_binding_problem_fk" FOREIGN KEY ("domain_problem_binding_id","problem_id") REFERENCES "domain_problem_bindings"("id","problem_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "submission_job_items" ADD CONSTRAINT "submission_job_items_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "submission_job_items" ADD CONSTRAINT "submission_job_items_workspace_job_fk" FOREIGN KEY ("domain_id","job_id") REFERENCES "submission_jobs"("domain_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "submission_job_items" ADD CONSTRAINT "submission_job_items_workspace_binding_fk" FOREIGN KEY ("domain_id","domain_problem_binding_id") REFERENCES "domain_problem_bindings"("domain_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "submission_job_items" ADD CONSTRAINT "submission_job_items_binding_problem_fk" FOREIGN KEY ("domain_problem_binding_id","problem_id") REFERENCES "domain_problem_bindings"("id","problem_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "submission_jobs" ADD CONSTRAINT "submission_jobs_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_workspace_contest_fk" FOREIGN KEY ("domain_id","contest_id") REFERENCES "contests"("domain_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_assignment_origin_fk" FOREIGN KEY ("domain_id","assignment_id","assignment_item_id") REFERENCES "assignment_items"("domain_id","assignment_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_assignment_problem_fk" FOREIGN KEY ("assignment_item_id","problem_id") REFERENCES "assignment_items"("id","problem_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_assignment_domain_fk" FOREIGN KEY ("domain_id","assignment_id") REFERENCES "assignments"("domain_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_workspace_binding_fk" FOREIGN KEY ("domain_id","domain_problem_binding_id") REFERENCES "domain_problem_bindings"("domain_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_binding_problem_fk" FOREIGN KEY ("domain_problem_binding_id","problem_id") REFERENCES "domain_problem_bindings"("id","problem_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "trainings" ADD CONSTRAINT "trainings_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_assignment_feedback_list" ON "assignment_feedback" USING btree ("domain_id","assignment_id","created_at");
--> statement-breakpoint
CREATE INDEX "idx_assignment_help_replies_list" ON "assignment_help_replies" USING btree ("help_id","created_at");
--> statement-breakpoint
CREATE INDEX "idx_assignment_help_requests_list" ON "assignment_help_requests" USING btree ("domain_id","assignment_id","state","created_at");
--> statement-breakpoint
CREATE INDEX "idx_assignment_items_binding" ON "assignment_items" USING btree ("domain_id","binding_id","assignment_id");
--> statement-breakpoint
CREATE INDEX "idx_assignment_progress_matrix" ON "assignment_progress" USING btree ("domain_id","assignment_id","user_id","scope");
--> statement-breakpoint
CREATE INDEX "idx_assignment_recipients_domain_user" ON "assignment_recipients" USING btree ("domain_id","user_id","assignment_id");
--> statement-breakpoint
CREATE INDEX "idx_assignments_class_state" ON "assignments" USING btree ("domain_id","classroom_id","state","deadline_at");
--> statement-breakpoint
CREATE INDEX "idx_classroom_memberships_domain_user" ON "classroom_memberships" USING btree ("domain_id","user_id","status");
--> statement-breakpoint
CREATE INDEX "idx_classrooms_domain_status" ON "classrooms" USING btree ("domain_id","status","created_at");
--> statement-breakpoint
CREATE INDEX "idx_domain_creation_requests_status" ON "domain_creation_requests" USING btree ("status");
--> statement-breakpoint
CREATE INDEX "idx_domain_feature_intervals_domain" ON "domain_feature_intervals" USING btree ("domain_id","feature");
--> statement-breakpoint
CREATE INDEX "idx_domain_invitations_domain" ON "domain_invitations" USING btree ("domain_id");
--> statement-breakpoint
CREATE INDEX "idx_domain_join_requests_domain_status" ON "domain_join_requests" USING btree ("domain_id","status");
--> statement-breakpoint
CREATE INDEX "idx_domain_memberships_user_status" ON "domain_memberships" USING btree ("user_id","status");
--> statement-breakpoint
CREATE INDEX "idx_domain_problem_bindings_source" ON "domain_problem_bindings" USING btree ("problem_id","domain_id");
--> statement-breakpoint
CREATE INDEX "idx_domain_storage_objects_url" ON "domain_storage_objects" USING btree ("storage_url");
--> statement-breakpoint
CREATE INDEX "idx_domain_storage_uploads_domain" ON "domain_storage_uploads" USING btree ("domain_id","state");
--> statement-breakpoint
CREATE INDEX "idx_domain_storage_uploads_expiry" ON "domain_storage_uploads" USING btree ("state","expires_at");
--> statement-breakpoint
CREATE INDEX "idx_domain_training_bindings_source" ON "domain_training_bindings" USING btree ("training_id");
--> statement-breakpoint
CREATE INDEX "idx_domains_owner" ON "domains" USING btree ("owner_id");
--> statement-breakpoint
CREATE INDEX "idx_education_disabled_intervals_domain" ON "education_disabled_intervals" USING btree ("domain_id","started_at");
--> statement-breakpoint
CREATE INDEX "idx_education_notification_emails_pending" ON "education_notification_emails" USING btree ("state","available_at","leased_until");
--> statement-breakpoint
CREATE INDEX "idx_education_notifications_user" ON "education_notifications" USING btree ("domain_id","user_id","created_at");
--> statement-breakpoint
CREATE INDEX "idx_education_outbox_pending" ON "education_outbox" USING btree ("processed_at","available_at","leased_until");
--> statement-breakpoint
CREATE INDEX "idx_submission_annotations_source" ON "submission_annotations" USING btree ("domain_id","classroom_id","submission_id","created_at");
--> statement-breakpoint
CREATE INDEX "idx_community_posts_workspace" ON "community_posts" USING btree ("domain_id","type","status","created_at");
--> statement-breakpoint
CREATE INDEX "idx_objective_submissions_domain_user_paper" ON "objective_submissions" USING btree ("domain_id","user_id","paper_id","created_at");
--> statement-breakpoint
CREATE INDEX "idx_search_entries_domain_type_updated" ON "search_entries" USING btree ("domain_id","entity_type","updated_at");
--> statement-breakpoint
CREATE INDEX "idx_self_tests_domain_user_created" ON "self_tests" USING btree ("domain_id","user_id","created_at");
--> statement-breakpoint
CREATE INDEX "idx_submissions_domain_user_created" ON "submissions" USING btree ("domain_id","user_id","created_at");
--> statement-breakpoint
CREATE INDEX "idx_submissions_domain_problem_user" ON "submissions" USING btree ("domain_id","problem_id","user_id");
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_action_check" CHECK ("audit_logs"."action" IN (
        'users.role_change',
        'users.ban',
        'users.unban',
        'users.delete',
        'roles.create',
        'roles.update',
        'roles.delete',
        'problems.delete',
        'problems.runtime_config_changed',
        'problems.imported',
        'problems.review',
        'problems.version_published',
        'problems.effective_version_policy_changed',
        'contest.problem_version_changed',
        'contest.problem_effective_version_policy_changed',
        'trainings.update',
        'trainings.delete',
        'tags.create',
        'tags.update',
        'tags.delete',
        'tags.merge',
        'submissions.rejudge',
        'submissions.queue_removed',
        'submissions.delete',
        'settings.update',
        'ip_ban.create',
        'ip_ban.delete',
        'auth.login_success',
        'auth.login_failure',
        'auth.register',
        'auth.email_verified',
        'auth.delete_account',
        'auth.change_password',
        'auth.forgot_password_request',
        'auth.password_reset',
        'auth.tfa_setup',
        'auth.tfa_enabled',
        'auth.tfa_disabled',
        'auth.tfa_recovery_regenerated',
        'auth.tfa_recovery_used',
        'community.post_moderated',
        'community.report_resolved',
        'community.sanction_created',
        'community.sanction_revoked',
        'community.preset_applied',
        'community.board_create',
        'community.board_update',
        'community.board_role_grant_update',
        'community.board_role_grant_delete',
        'community.post_flag',
        'announcement.create',
        'announcement.update',
        'announcement.delete',
        'carousel.create',
        'carousel.update',
        'carousel.delete',
        'carousel.reorder',
        'review.queued',
        'review.rejected',
        'review.resolved',
        'contest.ranking_snapshot',
        'contest.create',
        'contest.update',
        'contest.delete',
        'contest.participants_add',
        'contest.participants_remove',
        'contest.kind_change',
        'contest.reset_code',
        'judge_images.create',
        'judge_images.update',
        'judge_images.delete',
        'email_delivery.clear_suppression',
        'llm_provider.create',
        'llm_provider.update',
        'llm_quota.upsert',
        'llm_model_alias.upsert',
        'llm_model_alias.delete',
        'legal.publish_version',
        'legal.data_request_update'
      ) OR "audit_logs"."action" IN ('domain.create', 'domain.update', 'domain.status', 'domain.join', 'domain.join_review', 'domain.member_roles', 'domain.member_remove', 'domain.transfer', 'domain.invite_create', 'domain.invite_accept', 'domain.invite_revoke', 'domain.llm_read', 'domain.llm_settings', 'domain.llm_provider', 'domain.llm_quota'));
--> statement-breakpoint
ALTER TABLE "community_moderation_actions" ADD CONSTRAINT "community_moderation_actions_workspace_check" CHECK (("community_moderation_actions"."target_type" IN ('message', 'user_ban') AND "community_moderation_actions"."domain_id" IS NULL)
        OR ("community_moderation_actions"."target_type" NOT IN ('message', 'user_ban') AND "community_moderation_actions"."domain_id" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "community_notifications" ADD CONSTRAINT "community_notifications_workspace_check" CHECK (("community_notifications"."type" IN ('reply', 'like', 'moderation', 'clarification') AND "community_notifications"."domain_id" IS NOT NULL)
        OR ("community_notifications"."type" IN ('follow', 'ban') AND "community_notifications"."domain_id" IS NULL)
        OR "community_notifications"."type" = 'report');
--> statement-breakpoint
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_binding_required_check" CHECK (("community_posts"."type" = 'solution' AND "community_posts"."domain_problem_binding_id" IS NOT NULL)
        OR ("community_posts"."type" <> 'solution' AND "community_posts"."domain_problem_binding_id" IS NULL));
--> statement-breakpoint
ALTER TABLE "community_reports" ADD CONSTRAINT "community_reports_workspace_check" CHECK (("community_reports"."content_type" = 'message' AND "community_reports"."domain_id" IS NULL)
        OR ("community_reports"."content_type" IN ('post', 'comment') AND "community_reports"."domain_id" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "contests" ADD CONSTRAINT "contests_type_check" CHECK ("contests"."type" IN ('kaggle', 'oi', 'ioi', 'ioi_strict', 'acm'));
--> statement-breakpoint
ALTER TABLE "llm_model_aliases" ADD CONSTRAINT "llm_model_aliases_revision_check" CHECK ("llm_model_aliases"."revision" >= 0);
--> statement-breakpoint
ALTER TABLE "objective_submissions" ADD CONSTRAINT "objective_submissions_assignment_origin_check" CHECK (("objective_submissions"."assignment_id" IS NULL) = ("objective_submissions"."assignment_item_id" IS NULL));
--> statement-breakpoint
ALTER TABLE "self_tests" ADD CONSTRAINT "self_tests_assignment_origin_check" CHECK (("self_tests"."assignment_id" IS NULL) = ("self_tests"."assignment_item_id" IS NULL));
--> statement-breakpoint
ALTER TABLE "submission_job_items" ADD CONSTRAINT "submission_job_items_binding_required_check" CHECK ("submission_job_items"."domain_problem_binding_id" IS NOT NULL OR "submission_job_items"."status" IN ('failed', 'skipped'));
--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_assignment_origin_check" CHECK (("submissions"."assignment_id" IS NULL) = ("submissions"."assignment_item_id" IS NULL));
--> statement-breakpoint
-- 旧生成列依赖 P/U 分类，按域内数字题号重建。
ALTER TABLE problems DROP COLUMN search_vector;

--> statement-breakpoint
ALTER TABLE "problems" DROP COLUMN "type";

--> statement-breakpoint
ALTER TABLE problems ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
  setweight(to_tsvector('simple', coalesce(number::text, '')), 'B')
) STORED;

--> statement-breakpoint
CREATE INDEX idx_problems_search_vector ON problems USING gin (search_vector);

--> statement-breakpoint
DELETE FROM role_permissions WHERE permission_id IN (
  SELECT id FROM permissions WHERE resource = 'problem' AND action = 'create_p'
);

--> statement-breakpoint
DELETE FROM permissions WHERE resource = 'problem' AND action = 'create_p';
