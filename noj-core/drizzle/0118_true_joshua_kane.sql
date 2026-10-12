CREATE SEQUENCE "submission_receipt_sequence" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
ALTER TABLE "contests" DROP CONSTRAINT "contests_type_check";--> statement-breakpoint
ALTER TABLE "objective_submissions" ADD COLUMN "receipt_sequence" bigint DEFAULT nextval('submission_receipt_sequence') NOT NULL;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "receipt_sequence" bigint DEFAULT nextval('submission_receipt_sequence') NOT NULL;--> statement-breakpoint
ALTER TABLE "contests" ADD CONSTRAINT "contests_type_check" CHECK ("contests"."type" IN ('kaggle', 'oi', 'ioi', 'ioi_strict', 'acm'));
