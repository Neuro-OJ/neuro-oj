-- 数据迁移：data_policy_* → legal_*（PIPL 合规，2026-09-23）
--
-- 背景：合规配置从"系统设置-其他"迁移到"法律与合规"分类。旧键
-- `data_policy_contact` / `data_policy_deployment` 的存量值需搬运到
-- `legal_contact` / `legal_operator_name`，避免部署者已填内容丢失。
--
-- 幂等：仅当旧键存在且新键缺失/为空时搬运；`ON CONFLICT DO NOTHING` 兜底
-- 「新键存在但值为空」的边界，避免主键冲突中断升级。随后删除旧键行。
-- 纯数据迁移，无 DDL，故不涉及迁移安全三步式。

INSERT INTO "system_settings" ("key", "value", "updated_at")
SELECT 'legal_contact', "value", "updated_at"
FROM "system_settings"
WHERE "key" = 'data_policy_contact'
  AND "value" <> ''
  AND NOT EXISTS (
    SELECT 1 FROM "system_settings" WHERE "key" = 'legal_contact' AND "value" <> ''
  )
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

INSERT INTO "system_settings" ("key", "value", "updated_at")
SELECT 'legal_operator_name', "value", "updated_at"
FROM "system_settings"
WHERE "key" = 'data_policy_deployment'
  AND "value" <> ''
  AND NOT EXISTS (
    SELECT 1 FROM "system_settings" WHERE "key" = 'legal_operator_name' AND "value" <> ''
  )
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

DELETE FROM "system_settings"
WHERE "key" IN ('data_policy_contact', 'data_policy_deployment');
