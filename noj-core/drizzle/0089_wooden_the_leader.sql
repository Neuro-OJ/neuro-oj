CREATE TABLE "carousel_slides" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"image_storage_url" text,
	"title" text,
	"subtitle" text,
	"gradient_key" text,
	"link_url" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "carousel_slides_kind_check" CHECK ("carousel_slides"."kind" IN ('image', 'text'))
);
--> statement-breakpoint
CREATE INDEX "idx_carousel_slides_enabled_sort" ON "carousel_slides" USING btree ("is_enabled","sort_order");