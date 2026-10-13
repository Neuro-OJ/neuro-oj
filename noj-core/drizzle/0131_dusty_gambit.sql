ALTER TABLE "search_entries" ADD COLUMN "domain_id" text;--> statement-breakpoint
ALTER TABLE "search_entries" ADD CONSTRAINT "search_entries_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_search_entries_domain_type_updated" ON "search_entries" USING btree ("domain_id","entity_type","updated_at");--> statement-breakpoint
UPDATE search_entries s SET domain_id = COALESCE(p.domain_id, (SELECT id FROM domains WHERE slug = 'main')) FROM problems p WHERE s.entity_type = 'problem' AND s.entity_id = p.id;--> statement-breakpoint
UPDATE search_entries s SET domain_id = COALESCE(c.domain_id, (SELECT id FROM domains WHERE slug = 'main')) FROM contests c WHERE s.entity_type = 'contest' AND s.entity_id = c.id;--> statement-breakpoint
UPDATE search_entries s SET domain_id = COALESCE(p.domain_id, (SELECT id FROM domains WHERE slug = 'main')) FROM community_posts p WHERE s.entity_type = 'community_post' AND s.entity_id = p.id;--> statement-breakpoint
UPDATE search_entries s SET domain_id = COALESCE(c.domain_id, (SELECT id FROM domains WHERE slug = 'main')) FROM community_comments c WHERE s.entity_type = 'community_comment' AND s.entity_id = c.id;--> statement-breakpoint
UPDATE search_entries s SET domain_id = COALESCE(t.domain_id, (SELECT id FROM domains WHERE slug = 'main')) FROM submissions t WHERE s.entity_type = 'submission' AND s.entity_id = t.id;
