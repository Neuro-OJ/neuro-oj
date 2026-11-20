ALTER TABLE "community_posts" DROP CONSTRAINT "community_posts_type_check";--> statement-breakpoint
ALTER TABLE "community_posts" DROP CONSTRAINT "community_posts_context_check";--> statement-breakpoint
ALTER TABLE "domain_invitations" DROP CONSTRAINT "domain_invitations_mode_check";--> statement-breakpoint
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_type_check" CHECK ("community_posts"."type" IN ('solution', 'discussion'));--> statement-breakpoint
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_context_check" CHECK ((
        ("community_posts"."type" = 'solution' AND "community_posts"."problem_id" IS NOT NULL AND "community_posts"."board_id" IS NULL AND "community_posts"."title" IS NOT NULL)
        OR ("community_posts"."type" = 'discussion' AND "community_posts"."board_id" IS NOT NULL AND "community_posts"."problem_id" IS NULL AND "community_posts"."title" IS NOT NULL)
      ));--> statement-breakpoint
ALTER TABLE "domain_invitations" ADD CONSTRAINT "domain_invitations_mode_check" CHECK ("domain_invitations"."mode" IN ('email','general'));