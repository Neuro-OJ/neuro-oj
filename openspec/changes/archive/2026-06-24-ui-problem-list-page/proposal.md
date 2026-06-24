## Why

Phase 1 的核心功能之一是题目浏览。用户目前无法在 noj-ui 中查看题目列表、按条件筛选或分页浏览。noj-core 已提供完整的题目管理 API（`GET /api/v1/problems` 支持多维度筛选与分页）和分类 API（`GET /api/v1/categories` 返回分类树），前端需要实现对应的交互页面。

## What Changes

- 新增题目列表页面 `/problems`，支持题号、标题、难度标签、分类、通过率的展示
- 新增搜索框组件，支持按标题/题号搜索
- 新增筛选面板，支持按难度（easy/medium/hard）和分类筛选
- 新增分页组件
- 每道题目显示通过状态（已解决/尝试过/未开始），通过提交记录判定
- 响应式布局适配移动端/桌面端

## Capabilities

### New Capabilities
- `problem-list-page`: 题目列表页功能，包括搜索、筛选、分页、通过状态展示，覆盖用户体验全流程

### Modified Capabilities

无。后端 API 规范无需修改，仅新增前端功能。

## Impact

- **noj-ui**: 新增页面路由 `/problems`，新增多个组件（搜索框、筛选面板、分页、题目卡片/表格）
- **API 依赖**: 使用 noj-core 现有 `GET /api/v1/problems` 和 `GET /api/v1/categories`
- **认证依赖**: 通过提交记录 API 判断用户对每道题的通过状态
- 无后端代码变更
