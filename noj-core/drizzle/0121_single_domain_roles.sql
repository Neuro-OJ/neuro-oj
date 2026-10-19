ALTER TABLE "domain_member_roles" DROP CONSTRAINT "domain_member_roles_role_check";--> statement-breakpoint
ALTER TABLE "domain_member_roles" ADD CONSTRAINT "domain_member_roles_membership_unique" UNIQUE("membership_id");--> statement-breakpoint
ALTER TABLE "domain_member_roles" ADD CONSTRAINT "domain_member_roles_role_check" CHECK ("domain_member_roles"."role" IN ('owner', 'coach', 'member'));