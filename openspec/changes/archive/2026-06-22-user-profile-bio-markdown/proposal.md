## Why

用户主页目前只展示 ID、用户名和注册时间，信息过于单薄。添加 Markdown 格式的个人简介（bio）字段后，用户可以在主页上自由书写自我介绍、技术栈、项目经历等内容，提升社区氛围和身份认同感。改动成本极低，ROI 高，属于 Phase 1 用户主页功能的自然补充。

## What Changes

- **数据库**：`users` 表新增可空字段 `bio` TEXT，存储 Markdown 格式的个人简介
- **后端 API**：
  - `GET /api/v1/users/:id/profile` 返回中 `user` 对象新增 `bio` 字段
  - 新增 `PUT /api/v1/users/me` 端点，允许已登录用户修改自己的 `bio`
- **前端 UI**：
  - 用户主页展示 `bio`（Markdown 渲染）
  - 个人设置页面/编辑资料入口可编辑 `bio`
- **不涉及**：URL 字段、短签名、审核流程、社交功能

## Capabilities

### New Capabilities
- `user-settings`: 已登录用户更新个人资料（bio）的 API

### Modified Capabilities
- `database-schema`: `users` 表增加 `bio` TEXT 列
- `user-profile`: 主页 API 响应中 `user` 对象返回 `bio` 字段

## Impact

| 模块 | 影响 |
|------|------|
| noj-core | `db/schema.ts` 新增字段、`services/users.ts` 更新 profile 查询、新增 `services/settings.ts` 和 `routes/settings.ts` 处理 bio 更新 |
| noj-ui | 用户主页新增 Markdown 渲染区、个人设置页新增 bio 编辑器 |
| 数据库 | 新增 migration: `ALTER TABLE users ADD COLUMN bio TEXT` |
