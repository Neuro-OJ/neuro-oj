ALTER TABLE "assignments" ADD COLUMN "source_training_id" text;--> statement-breakpoint
ALTER TABLE "assignments" ADD COLUMN "source_training_rule" jsonb;--> statement-breakpoint
ALTER TABLE "trainings" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_source_training_id_trainings_id_fk" FOREIGN KEY ("source_training_id") REFERENCES "trainings"("id") ON DELETE no action ON UPDATE no action;
