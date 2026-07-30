CREATE TABLE "contest_clarifications" (
	"id" text PRIMARY KEY NOT NULL,
	"contest_id" text NOT NULL,
	"problem_id" text,
	"sender_id" text NOT NULL,
	"content" text NOT NULL,
	"reply_to_id" text,
	"is_public" boolean DEFAULT false NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contest_participants" (
	"contest_id" text NOT NULL,
	"user_id" text NOT NULL,
	"registered_at" text NOT NULL,
	CONSTRAINT "contest_participants_contest_id_user_id_pk" PRIMARY KEY("contest_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "contest_problems" (
	"contest_id" text NOT NULL,
	"problem_id" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"label" text NOT NULL,
	"score" integer,
	CONSTRAINT "contest_problems_contest_id_problem_id_pk" PRIMARY KEY("contest_id","problem_id"),
	CONSTRAINT "contest_problems_contest_label_unique" UNIQUE("contest_id","label"),
	CONSTRAINT "contest_problems_contest_sort_order_unique" UNIQUE("contest_id","sort_order")
);
--> statement-breakpoint
CREATE TABLE "contests" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"start_time" text NOT NULL,
	"end_time" text NOT NULL,
	"type" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_public" boolean DEFAULT true NOT NULL,
	"password" text,
	"affect_global_ranking" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"announcement" text DEFAULT '' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "contests_type_check" CHECK ("contests"."type" IN ('icpc', 'ioi', 'oi')),
	CONSTRAINT "contests_time_check" CHECK ("contests"."end_time" > "contests"."start_time"),
	CONSTRAINT "contests_config_check" CHECK (jsonb_typeof("contests"."config") = 'object')
);
--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "contest_id" text;--> statement-breakpoint
ALTER TABLE "contest_clarifications" ADD CONSTRAINT "contest_clarifications_contest_id_contests_id_fk" FOREIGN KEY ("contest_id") REFERENCES "public"."contests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contest_clarifications" ADD CONSTRAINT "contest_clarifications_problem_id_problems_id_fk" FOREIGN KEY ("problem_id") REFERENCES "public"."problems"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contest_clarifications" ADD CONSTRAINT "contest_clarifications_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contest_clarifications" ADD CONSTRAINT "contest_clarifications_reply_to_id_contest_clarifications_id_fk" FOREIGN KEY ("reply_to_id") REFERENCES "public"."contest_clarifications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contest_participants" ADD CONSTRAINT "contest_participants_contest_id_contests_id_fk" FOREIGN KEY ("contest_id") REFERENCES "public"."contests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contest_participants" ADD CONSTRAINT "contest_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contest_problems" ADD CONSTRAINT "contest_problems_contest_id_contests_id_fk" FOREIGN KEY ("contest_id") REFERENCES "public"."contests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contest_problems" ADD CONSTRAINT "contest_problems_problem_id_problems_id_fk" FOREIGN KEY ("problem_id") REFERENCES "public"."problems"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contests" ADD CONSTRAINT "contests_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_contest_participants_user" ON "contest_participants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_contests_created_by" ON "contests" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "idx_contests_start_time" ON "contests" USING btree ("start_time");--> statement-breakpoint
CREATE INDEX "idx_contests_end_time" ON "contests" USING btree ("end_time");--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_contest_id_contests_id_fk" FOREIGN KEY ("contest_id") REFERENCES "public"."contests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_submissions_contest_id" ON "submissions" USING btree ("contest_id");--> statement-breakpoint
CREATE INDEX "idx_submissions_contest_problem_user" ON "submissions" USING btree ("contest_id","problem_id","user_id","created_at");