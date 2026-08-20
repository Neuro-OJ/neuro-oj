## Purpose

定义 Neuro OJ 分类系统规范。分类系统已整体退役，由双类标签系统（`problem-tags`）取代。

## Requirements

### Requirement: 分类系统退役

系统 SHALL 不再提供分类树、分类 CRUD 与题目-分类关联（`categories` / `problems_categories`）；相关能力 MUST 由标签系统（`tags` / `problem_tags`）取代。

#### Scenario: 旧分类接口访问

- **WHEN** 客户端请求已退役的 `/api/v1/categories` 或使用 `category_ids` 字段
- **THEN** 系统不再返回分类数据/不再接受该字段，并迁移至 `/api/v1/tags` 与 `tag_ids`
