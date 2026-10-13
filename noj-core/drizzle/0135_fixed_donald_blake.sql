-- 完成扩展阶段的存量回填。空库留给既有初始化流程，不创建可登录账号。
WITH initialized AS (
  INSERT INTO domains (id, slug, name, owner_id, preset, configuration, created_at, updated_at)
  SELECT '00000000-0000-4000-8000-000000000001', 'main', 'Neuro OJ', u.id, 'community',
    '{"access":"public","discoverable":true,"join_policy":"open","features":{"community":true,"classroom":false,"assignment":false,"analytics":false},"homepage":"community"}'::jsonb,
    to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  FROM users u WHERE u.id = '0' AND (
    EXISTS (SELECT 1 FROM problems WHERE domain_id IS NULL)
    OR EXISTS (SELECT 1 FROM trainings WHERE domain_id IS NULL)
  )
  ON CONFLICT (slug) DO NOTHING RETURNING id, owner_id, created_at
), members AS (
  INSERT INTO domain_memberships (id, domain_id, user_id, joined_at)
  SELECT gen_random_uuid()::text, initialized.id, u.id, initialized.created_at
  FROM initialized CROSS JOIN users u WHERE u.deleted_at IS NULL
  RETURNING id, user_id
)
INSERT INTO domain_member_roles (membership_id, role)
SELECT id, CASE WHEN user_id = '0' THEN 'owner' ELSE 'member' END FROM members;--> statement-breakpoint
INSERT INTO domain_limits (domain_id)
SELECT id FROM domains WHERE id = '00000000-0000-4000-8000-000000000001'
ON CONFLICT (domain_id) DO NOTHING;--> statement-breakpoint
UPDATE problems SET domain_id = '00000000-0000-4000-8000-000000000001' WHERE domain_id IS NULL;--> statement-breakpoint
UPDATE trainings SET domain_id = '00000000-0000-4000-8000-000000000001' WHERE domain_id IS NULL;--> statement-breakpoint
WITH bound AS (
  INSERT INTO domain_problem_bindings (id, domain_id, problem_id, kind, visibility,
    effective_version_mode, required_version_id, revision, created_by, created_at, updated_at)
  SELECT gen_random_uuid()::text, p.domain_id, p.id, 'owned',
    CASE WHEN p.visibility = 'public' THEN 'public' ELSE 'members' END,
    p.effective_version_mode, p.required_version_id, p.effective_policy_revision,
    d.owner_id, p.created_at, p.updated_at
  FROM problems p JOIN domains d ON d.id = p.domain_id
  ON CONFLICT (domain_id, problem_id) DO NOTHING RETURNING *
)
INSERT INTO problem_binding_history (id, binding_id, problem_id, revision,
  effective_version_mode, required_version_id, answer_version_id, actor_id, reason, created_at)
SELECT gen_random_uuid()::text, b.id, b.problem_id, b.revision, b.effective_version_mode,
  b.required_version_id, COALESCE(b.required_version_id, p.latest_version_id),
  b.created_by, '存量源题归属收缩迁移', b.updated_at
FROM bound b JOIN problems p ON p.id = b.problem_id;--> statement-breakpoint
INSERT INTO domain_resource_counters (domain_id, resource, used)
SELECT d.id, resource, CASE resource
    WHEN 'members' THEN (SELECT count(*) FROM domain_memberships m WHERE m.domain_id = d.id AND m.status = 'active')
    WHEN 'problems' THEN (SELECT count(*) FROM domain_problem_bindings b WHERE b.domain_id = d.id)
    ELSE 0 END
FROM domains d CROSS JOIN (VALUES ('members'), ('problems'), ('storage_bytes')) AS resources(resource)
WHERE d.id = '00000000-0000-4000-8000-000000000001'
ON CONFLICT (domain_id, resource) DO NOTHING;--> statement-breakpoint
UPDATE domains SET next_problem_number = GREATEST(next_problem_number,
  COALESCE((SELECT max(p.number) + 1 FROM problems p WHERE p.domain_id = domains.id), 1001))
WHERE id = '00000000-0000-4000-8000-000000000001';--> statement-breakpoint
ALTER TABLE "problems" ALTER COLUMN "domain_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "trainings" ALTER COLUMN "domain_id" SET NOT NULL;
