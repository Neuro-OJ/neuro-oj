ALTER TABLE "problems" DROP CONSTRAINT "problems_type_check";--> statement-breakpoint
ALTER TABLE "problems" ADD COLUMN "is_objective" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "problems" ADD CONSTRAINT "problems_type_check" CHECK ("problems"."type" IN ('U', 'P'));