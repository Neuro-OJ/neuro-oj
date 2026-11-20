CREATE TABLE "problem_difficulty" (
	"problem_id" text PRIMARY KEY NOT NULL,
	"prior" integer NOT NULL,
	"calibrated" integer NOT NULL,
	"sample_size" integer DEFAULT 0 NOT NULL,
	"pass_ratio_override" integer,
	"updated_at" text NOT NULL,
	CONSTRAINT "problem_difficulty_range_check" CHECK ("problem_difficulty"."prior" >= 0 AND "problem_difficulty"."prior" <= 100
        AND "problem_difficulty"."calibrated" >= 0 AND "problem_difficulty"."calibrated" <= 100
        AND "problem_difficulty"."sample_size" >= 0),
	CONSTRAINT "problem_difficulty_pass_ratio_check" CHECK ("problem_difficulty"."pass_ratio_override" IS NULL
        OR ("problem_difficulty"."pass_ratio_override" >= 0 AND "problem_difficulty"."pass_ratio_override" <= 100))
);
--> statement-breakpoint
ALTER TABLE "problem_difficulty" ADD CONSTRAINT "problem_difficulty_problem_id_problems_id_fk" FOREIGN KEY ("problem_id") REFERENCES "problems"("id") ON DELETE cascade ON UPDATE no action;