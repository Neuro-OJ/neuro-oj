## Purpose

定义 Neuro OJ 管理后台分类管理页面规范。该页面已退役，由 `/admin/tags` 标签管理页（`admin-tag-management`）取代。

## Requirements

### Requirement: 分类管理页面退役

系统 SHALL 不再提供 `/admin/categories` 分类管理页面与分类管理端点；分类相关能力 MUST 迁移至 `/admin/tags` 标签管理页与标签 API。

#### Scenario: 访问旧分类管理页

- **WHEN** 用户访问已退役的 `/admin/categories`
- **THEN** 系统不再提供该页面（重定向或 404），并引导使用 `/admin/tags`
