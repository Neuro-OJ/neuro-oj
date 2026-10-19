-- 旧非负责人角色不自动提升为全域教练；负责人重新任命。
DELETE FROM domain_member_roles;
--> statement-breakpoint
INSERT INTO domain_member_roles (membership_id, role)
SELECT m.id, CASE WHEN d.owner_id = m.user_id THEN 'owner' ELSE 'member' END
FROM domain_memberships m JOIN domains d ON d.id = m.domain_id;
--> statement-breakpoint
DELETE FROM classroom_assistant_grants;
--> statement-breakpoint
UPDATE classroom_memberships SET status = 'removed',
  left_at = COALESCE(left_at, CURRENT_TIMESTAMP::text)
WHERE role IN ('coach', 'assistant');
--> statement-breakpoint
UPDATE domains SET revision = revision + 1;
