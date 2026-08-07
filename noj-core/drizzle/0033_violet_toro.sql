CREATE TABLE "objective_questions" (
	"id" text PRIMARY KEY NOT NULL,
	"paper_id" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"type" text NOT NULL,
	"prompt" text NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"answer" jsonb NOT NULL,
	"explanation" text DEFAULT '' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "objective_questions_paper_sort_unique" UNIQUE("paper_id","sort_order"),
	CONSTRAINT "objective_questions_type_check" CHECK ("objective_questions"."type" IN ('single', 'multiple', 'judge'))
);
--> statement-breakpoint
CREATE TABLE "objective_submissions" (
	"id" text PRIMARY KEY NOT NULL,
	"paper_id" text NOT NULL,
	"user_id" text NOT NULL,
	"contest_id" text,
	"submission_type" text NOT NULL,
	"answers" jsonb NOT NULL,
	"status" text DEFAULT 'finished' NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "objective_submissions_contest_unique" UNIQUE("paper_id","user_id","contest_id"),
	CONSTRAINT "objective_submissions_type_check" CHECK ("objective_submissions"."submission_type" IN ('practice', 'contest'))
);
--> statement-breakpoint
ALTER TABLE "problems" DROP CONSTRAINT "problems_type_check";--> statement-breakpoint
ALTER TABLE "problems" ALTER COLUMN "runtime_config" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "objective_questions" ADD CONSTRAINT "objective_questions_paper_id_problems_id_fk" FOREIGN KEY ("paper_id") REFERENCES "problems"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objective_submissions" ADD CONSTRAINT "objective_submissions_paper_id_problems_id_fk" FOREIGN KEY ("paper_id") REFERENCES "problems"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objective_submissions" ADD CONSTRAINT "objective_submissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objective_submissions" ADD CONSTRAINT "objective_submissions_contest_id_contests_id_fk" FOREIGN KEY ("contest_id") REFERENCES "contests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_objective_questions_paper_id" ON "objective_questions" USING btree ("paper_id");--> statement-breakpoint
CREATE INDEX "idx_objective_submissions_paper_id" ON "objective_submissions" USING btree ("paper_id");--> statement-breakpoint
CREATE INDEX "idx_objective_submissions_user_id" ON "objective_submissions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_objective_submissions_user_paper_created" ON "objective_submissions" USING btree ("user_id","paper_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_objective_submissions_contest_id" ON "objective_submissions" USING btree ("contest_id");--> statement-breakpoint
ALTER TABLE "problems" ADD CONSTRAINT "problems_type_check" CHECK ("problems"."type" IN ('U', 'P', 'O'));