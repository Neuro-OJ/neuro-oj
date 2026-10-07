# Agent Note: 清理 VULN-06 下线 IP 风控后残留的过时描述，权限描述随种子同步

Status: implemented

## Problem

2026-09-28 安全审计 VULN-06 已整体下线基于来源 IP 的竞赛风控（删除 `submissions.client_ip` 及 ip-groups / timeline 端点），但仍有几处描述停留在旧状态：

- 权限 `contest:anti_cheat_read` 的描述仍为「查看竞赛风控关联线索（IP 与提交时间线）」，实际只用于代码相似度查询端点 `GET /api/v1/admin/contest/contests/:id/anti-cheat/similar-submissions`；
- `noj-docs/docs/operators/legal-compliance.md` 数据清单「评测」一行仍列出「来源 IP」，「反作弊」一行仍为「提交来源 IP（默认 180 天）」；
- `contest-similarity.ts` 文件头与 admin contest 路由注释仍引用已不存在的 IP 关联逻辑 / 「其余风控端点」。

此外，`ensurePermissions()` 对已存在的 `(resource, action)` 使用 `onConflictDoNothing`，只改代码中的描述不会更新存量库，管理端角色页仍会显示旧文案。

## Decision

- 权限描述改为「查看竞赛风控线索（代码相似度）」。
- `ensurePermissions()` 改为 `onConflictDoUpdate`，冲突时仅同步 `description`，并以 `setWhere ... IS DISTINCT FROM excluded.description` 避免描述未变时产生无意义更新。权限描述在管理端不可编辑（只有角色描述可编辑），以代码为唯一真相源是安全的；主键与 `role_permissions` 绑定不受影响。启动时 `ensureRbacSeeds()` 即完成存量库修正，无需数据迁移。
- `rbac.test.ts` 新增用例：把存量行描述改回旧文案后执行 `ensureRbacSeeds()`，断言描述被同步且主键不变。
- 法律合规文档：「评测」行删去来源 IP；「反作弊」行改为代码相似度复核所用的已有提交与指纹统计，并加注说明 IP 风控已下线、`data_policy.retention_days` 为 180 天的声明口径，以及 NOJ 当前不会自动清理提交记录（如实反映实现，避免部署者误以为有自动删除）。同文件的注册同意 IP（`user_consents.ip`）与审计 IP（`audit_logs.ip_address`）仍在采集，保持不变。
- 顺带修正 `contest-similarity.ts` 文件头与 `admin/routes/contest.ts` 端点注释。

## Alternatives considered

- **写一条 `UPDATE permissions SET description = ...` 数据迁移**：只能修这一次，下次改描述又会漂移，还要为纯文案变更增加迁移文件；种子同步一次性解决。
- **保持 `onConflictDoNothing`，只改代码**：新库正确、存量库永远显示旧文案，与审计整改目的不符。

## Consequences

- 今后修改 `PERMISSION_DEFS` 中的描述，重启 noj-core 即同步到所有环境；若将来允许管理员编辑权限描述，需要重新评估此处的覆盖行为。
- 法律合规文档中「180 天」现在明确为声明口径而非自动执行的留存任务；如需落实自动清理，应另行实现并更新该说明。
