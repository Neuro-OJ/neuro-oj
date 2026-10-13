ALTER TABLE "community_boards" DROP CONSTRAINT "community_boards_slug_unique";--> statement-breakpoint
ALTER TABLE "community_boards" ADD COLUMN "domain_id" text;--> statement-breakpoint
ALTER TABLE "community_boards" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "community_comments" ADD COLUMN "domain_id" text;--> statement-breakpoint
ALTER TABLE "community_moderation_actions" ADD COLUMN "domain_id" text;--> statement-breakpoint
ALTER TABLE "community_notifications" ADD COLUMN "domain_id" text;--> statement-breakpoint
ALTER TABLE "community_posts" ADD COLUMN "domain_id" text;--> statement-breakpoint
ALTER TABLE "community_posts" ADD COLUMN "domain_problem_binding_id" text;--> statement-breakpoint
ALTER TABLE "community_reports" ADD COLUMN "domain_id" text;--> statement-breakpoint
ALTER TABLE "community_sanctions" ADD COLUMN "domain_id" text;--> statement-breakpoint
ALTER TABLE "community_boards" ADD CONSTRAINT "community_boards_domain_id_unique" UNIQUE("id","domain_id");--> statement-breakpoint
ALTER TABLE "community_boards" ADD CONSTRAINT "community_boards_domain_slug_unique" UNIQUE("domain_id","slug");--> statement-breakpoint
ALTER TABLE "community_comments" ADD CONSTRAINT "community_comments_domain_id_unique" UNIQUE("id","domain_id");--> statement-breakpoint
ALTER TABLE "community_comments" ADD CONSTRAINT "community_comments_post_domain_unique" UNIQUE("id","post_id","domain_id");--> statement-breakpoint
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_domain_id_unique" UNIQUE("id","domain_id");--> statement-breakpoint
ALTER TABLE "community_boards" ADD CONSTRAINT "community_boards_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_comments" ADD CONSTRAINT "community_comments_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_comments" ADD CONSTRAINT "community_comments_workspace_post_fk" FOREIGN KEY ("post_id","domain_id") REFERENCES "community_posts"("id","domain_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_comments" ADD CONSTRAINT "community_comments_workspace_parent_fk" FOREIGN KEY ("parent_id","post_id","domain_id") REFERENCES "community_comments"("id","post_id","domain_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_moderation_actions" ADD CONSTRAINT "community_moderation_actions_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_notifications" ADD CONSTRAINT "community_notifications_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_workspace_board_fk" FOREIGN KEY ("board_id","domain_id") REFERENCES "community_boards"("id","domain_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_workspace_binding_fk" FOREIGN KEY ("domain_problem_binding_id","domain_id") REFERENCES "domain_problem_bindings"("id","domain_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_binding_problem_fk" FOREIGN KEY ("domain_problem_binding_id","problem_id") REFERENCES "domain_problem_bindings"("id","problem_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_reports" ADD CONSTRAINT "community_reports_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_sanctions" ADD CONSTRAINT "community_sanctions_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "community_boards_legacy_slug_unique" ON "community_boards" USING btree ("slug") WHERE "community_boards"."domain_id" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_community_posts_workspace" ON "community_posts" USING btree ("domain_id","type","status","created_at");--> statement-breakpoint
UPDATE community_boards SET domain_id = (SELECT id FROM domains WHERE slug = 'main') WHERE domain_id IS NULL;--> statement-breakpoint
UPDATE community_posts SET domain_id = (SELECT id FROM domains WHERE slug = 'main') WHERE domain_id IS NULL;--> statement-breakpoint
UPDATE community_posts p SET domain_problem_binding_id = b.id FROM domain_problem_bindings b WHERE p.problem_id = b.problem_id AND p.domain_id = b.domain_id AND p.domain_problem_binding_id IS NULL;--> statement-breakpoint
UPDATE community_comments c SET domain_id = p.domain_id FROM community_posts p WHERE c.post_id = p.id AND c.domain_id IS NULL;--> statement-breakpoint
UPDATE community_reports r SET domain_id = p.domain_id FROM community_posts p WHERE r.post_id = p.id AND r.domain_id IS NULL;--> statement-breakpoint
UPDATE community_reports r SET domain_id = c.domain_id FROM community_comments c WHERE r.comment_id = c.id AND r.domain_id IS NULL;--> statement-breakpoint
UPDATE community_sanctions SET domain_id = (SELECT id FROM domains WHERE slug = 'main') WHERE domain_id IS NULL;--> statement-breakpoint
UPDATE community_moderation_actions SET domain_id = (SELECT id FROM domains WHERE slug = 'main') WHERE domain_id IS NULL AND target_type NOT IN ('message', 'user_ban');--> statement-breakpoint
UPDATE community_notifications n SET domain_id = p.domain_id FROM community_posts p WHERE n.post_id = p.id AND n.domain_id IS NULL;--> statement-breakpoint
UPDATE community_notifications n SET domain_id = c.domain_id FROM community_comments c WHERE n.comment_id = c.id AND n.domain_id IS NULL;
