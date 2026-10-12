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
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_teaching_source_unique" UNIQUE("domain_id","id","user_id");--> statement-breakpoint
ALTER TABLE "submission_annotations" ADD CONSTRAINT "submission_annotations_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_annotations" ADD CONSTRAINT "submission_annotations_classroom_fk" FOREIGN KEY ("domain_id","classroom_id") REFERENCES "classrooms"("domain_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_annotations" ADD CONSTRAINT "submission_annotations_source_fk" FOREIGN KEY ("domain_id","submission_id","user_id") REFERENCES "submissions"("domain_id","id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_submission_annotations_source" ON "submission_annotations" USING btree ("domain_id","classroom_id","submission_id","created_at");
