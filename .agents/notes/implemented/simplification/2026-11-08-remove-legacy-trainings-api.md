# Agent Note: 删除旧实例级题单 API 与管理后台旧 catalog 端点

Status: implemented

## Problem

0.11 起题单只存在于域内（`/api/v1/domains/:slug/trainings`），但无域的
`/api/v1/trainings` 路由及约 700 行写服务仍在。前端只剩两处读调用：用户主页按
创建者列出题单，以及默认域中间件把旧链接 `/trainings/<ref>` 解析成内部 ID。
管理后台的 `GET /admin/catalog/problems/:id/preflight` 已被域内发布预检取代，
`/admin/catalog/trainings*` 也没有前端调用方。

## Decision

- 删除 `/api/v1/trainings` 全部路由、写服务及对应应用层命令；只保留用户主页用到的
  `listUserTrainings`。
- 域内题单列表新增 `?created_by=` 过滤；用户主页改调域内接口。
- 旧链接 `/trainings/<ref>` 直接 301 到 `/d/main/trainings/<ref>`；
  `resolveDomainTraining` 同时接受内部 UUID 与 `public_id`，旧链接依然可用。
- 删除管理后台旧发布预检与题单管理端点，保留竞赛选题器使用的
  `GET /admin/catalog/problems`。

## Alternatives considered

- 中间件改为通过域内列表接口查找 `public_id`：多一次请求，且分页下不可靠；
  让域内详情接口直接接受 `public_id` 更简单。

## Consequences

- 外部脚本调用旧 `/api/v1/trainings` 会得到 404。
- 用户主页的题单卡片显示发布状态，不再显示题数（域内列表不返回题数）。
