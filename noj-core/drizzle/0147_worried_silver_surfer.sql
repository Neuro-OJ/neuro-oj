ALTER TABLE "user_knowledge_mastery" ADD COLUMN "ability_score" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_knowledge_mastery" ADD COLUMN "evidence_weight" real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_knowledge_mastery" ADD COLUMN "last_passed_at" text;--> statement-breakpoint
ALTER TABLE "user_knowledge_mastery" ADD CONSTRAINT "user_knowledge_mastery_ability_score_check" CHECK ("user_knowledge_mastery"."ability_score" >= 0 AND "user_knowledge_mastery"."ability_score" <= 100);--> statement-breakpoint
ALTER TABLE "user_knowledge_mastery" ADD CONSTRAINT "user_knowledge_mastery_evidence_weight_check" CHECK ("user_knowledge_mastery"."evidence_weight" >= 0);