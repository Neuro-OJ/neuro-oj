CREATE TABLE "self_tests" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"problem_id" text NOT NULL,
	"language" text NOT NULL,
	"code" text NOT NULL,
	"file_name" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"output" text DEFAULT '' NOT NULL,
	"details" text DEFAULT '{}' NOT NULL,
	"time_ms" integer,
	"memory_kb" integer,
	"judge_started_at" text,
	"judge_finished_at" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "self_tests" ADD CONSTRAINT "self_tests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "self_tests" ADD CONSTRAINT "self_tests_problem_id_problems_id_fk" FOREIGN KEY ("problem_id") REFERENCES "problems"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_self_tests_user_id" ON "self_tests" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_self_tests_problem_id" ON "self_tests" USING btree ("problem_id");--> statement-breakpoint
CREATE INDEX "idx_self_tests_created_at" ON "self_tests" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_self_tests_user_id_created_at" ON "self_tests" USING btree ("user_id","created_at");