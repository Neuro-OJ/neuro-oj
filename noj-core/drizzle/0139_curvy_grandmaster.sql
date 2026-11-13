CREATE TABLE "knowledge_areas" (
	"id" text PRIMARY KEY NOT NULL,
	"pack_id" text NOT NULL,
	"name" text NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_edges" (
	"from_id" text NOT NULL,
	"to_id" text NOT NULL,
	CONSTRAINT "knowledge_edges_from_id_to_id_pk" PRIMARY KEY("from_id","to_id")
);
--> statement-breakpoint
CREATE TABLE "knowledge_nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"area_id" text NOT NULL,
	"pack_id" text NOT NULL,
	"name" text NOT NULL,
	"summary" text NOT NULL,
	"syllabus" jsonb DEFAULT '[]' NOT NULL,
	"doc_path" text,
	"status" text DEFAULT 'active' NOT NULL,
	"replaced_by" text,
	"sort" integer DEFAULT 0 NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "knowledge_nodes_status_check" CHECK ("knowledge_nodes"."status" IN ('active', 'deprecated'))
);
--> statement-breakpoint
CREATE TABLE "knowledge_packs" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"version" text NOT NULL,
	"license" text NOT NULL,
	"extends" text,
	"active" boolean DEFAULT false NOT NULL,
	"imported_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "knowledge_areas" ADD CONSTRAINT "knowledge_areas_pack_id_knowledge_packs_id_fk" FOREIGN KEY ("pack_id") REFERENCES "knowledge_packs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_edges" ADD CONSTRAINT "knowledge_edges_from_id_knowledge_nodes_id_fk" FOREIGN KEY ("from_id") REFERENCES "knowledge_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_edges" ADD CONSTRAINT "knowledge_edges_to_id_knowledge_nodes_id_fk" FOREIGN KEY ("to_id") REFERENCES "knowledge_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_nodes" ADD CONSTRAINT "knowledge_nodes_area_id_knowledge_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "knowledge_areas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_nodes" ADD CONSTRAINT "knowledge_nodes_pack_id_knowledge_packs_id_fk" FOREIGN KEY ("pack_id") REFERENCES "knowledge_packs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_areas_pack_idx" ON "knowledge_areas" USING btree ("pack_id");--> statement-breakpoint
CREATE INDEX "knowledge_nodes_area_idx" ON "knowledge_nodes" USING btree ("area_id");