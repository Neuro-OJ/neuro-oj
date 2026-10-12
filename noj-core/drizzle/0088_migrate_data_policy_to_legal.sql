-- 数据迁移：data_policy_* → legal_*（PIPL 合规，2026-09-23）
--
-- 背景：合规配置从"系统设置-其他"迁移到"法律与合规"分类。旧键
-- `data_policy_contact` 的存量值搬运到 `legal_contact`；旧键
-- `data_policy_deployment` 的语义是"部署补充说明"（存储区域/保留期限/备份/
-- 第三方服务…），搬运到 `legal_deployment_notes`。
--
-- 2026-09-25 评审修正：此前把 `data_policy_deployment` 搬进
-- `legal_operator_name`（个人信息处理者名称），语义错位——`/api/v1/data-policy`
-- 会把多行部署说明渲染成"处理者：<说明>"。已在同一 PR 内改正搬运目标。
-- 注意：若某环境已应用过本迁移的旧文本，drizzle 不会重跑，需人工确认这两行
-- 配置（`legal_operator_name` 是否被写入说明、`legal_deployment_notes` 是否为空）。
--
-- 幂等：仅当旧键存在且新键缺失/为空时搬运；`ON CONFLICT DO NOTHING` 兜底
-- 「新键存在但值为空」的边界，避免主键冲突中断升级。随后删除旧键行。
-- 「空」判定同时覆盖 '' 与 '""'（updateSetting 落库为 JSON.stringify(value)，
-- 空串存的是两个字符 `""`；2026-09-24 评审修正，避免误判非空跳过搬运后丢旧值）。
-- 纯数据迁移，无 DDL，故不涉及迁移安全三步式。

INSERT INTO "system_settings" ("key", "value", "updated_at")
SELECT 'legal_contact', "value", "updated_at"
FROM "system_settings"
WHERE "key" = 'data_policy_contact'
  AND "value" <> '' AND "value" <> '""'
  AND NOT EXISTS (
    SELECT 1 FROM "system_settings"
    WHERE "key" = 'legal_contact' AND "value" <> '' AND "value" <> '""'
  )
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

INSERT INTO "system_settings" ("key", "value", "updated_at")
SELECT 'legal_deployment_notes', "value", "updated_at"
FROM "system_settings"
WHERE "key" = 'data_policy_deployment'
  AND "value" <> '' AND "value" <> '""'
  AND NOT EXISTS (
    SELECT 1 FROM "system_settings"
    WHERE "key" = 'legal_deployment_notes' AND "value" <> '' AND "value" <> '""'
  )
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

DELETE FROM "system_settings"
WHERE "key" IN ('data_policy_contact', 'data_policy_deployment');
