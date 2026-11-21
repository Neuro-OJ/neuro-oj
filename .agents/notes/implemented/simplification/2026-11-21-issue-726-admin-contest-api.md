# Agent Note: #726 P1 第三批：删除管理端无域比赛接口

Status: implemented

## Problem

`noj-core/src/modules/http/admin/routes/contest.ts`（803 行）挂在
`/api/v1/admin/contest`，只能操作 `main` 域比赛（经 `resolveDefaultContestAccess`
固定默认域）。前端早已不调用它，比赛 CRUD、参与者、成绩发布都有域入口；但有两项
能力只在这里：

- 正式成绩导出（latest / 指定版本的 JSON 与 CSV，含分数换算与 CSV 注入防护）；
- 比赛内相似提交（`contest:anti_cheat_read`）。

E2E 的 5 个文件仍用它建赛、改结束时间、发布成绩。

## Decision

- 两项独有能力迁到域入口：
  - `GET /api/v1/domains/:slug/contests/:id/snapshots/:file`，`:file` 为
    `latest|<版本号>` 加 `.json|.csv`；仍用单段参数自行拆分（Hono 不支持
    `:version.json`）。
  - `GET /api/v1/domains/:slug/contests/:id/anti-cheat/similar-submissions`：
    要求比赛组织者，并额外要求 `contest:anti_cheat_read`（域教师默认具备）；
    `problem_id` 只在本场赛题内按题目 ID 或标签解析，不再全局解析题号。
- 导出与参数解析函数移到 `contests/routes/ranking-export.ts`，逻辑不变。
- 比赛管理页正式成绩版本列表新增「导出 CSV」；下载时补回被解码去掉的 BOM。
- 删除管理端路由、`resolveDefaultContestAccess` 及只测管理端的
  `admin-contests.test.ts`；E2E 改走域入口（PATCH 带 `If-Match` revision，
  发布走 `publish-ranking`，去掉域入口拒绝的 `is_public`）。
- 比赛提交列表不迁：域提交列表已支持 `contest_id` 过滤。

## Alternatives considered

- **整个文件直接删，不迁导出与查重**：导出是运营归档的唯一途径，查重有运营
  文档与处置流程依赖，删掉是功能回退。
- **相似度只要求组织者**：会让 `contest:anti_cheat_read` 变成无用权限，也放宽了
  原有口径；保留该能力检查。

## Consequences

- 外部脚本若调用 `/api/v1/admin/contest/**` 会 404，需改走域入口（CHANGELOG
  标为破坏性）。
- 导出 CSV 的 `Cache-Control` 由域路由统一为 `no-store`（原为
  `private, no-store`），仍禁止缓存。
- 相似度仍没有页面入口，运营按 `noj-docs/docs/operators/contest-similarity.md`
  调用接口。
