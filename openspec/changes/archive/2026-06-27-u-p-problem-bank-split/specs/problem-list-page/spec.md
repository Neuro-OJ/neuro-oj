## Purpose

题目列表页增量更新：新增 type 筛选、display_id 列展示。

## MODIFIED Requirements

### Requirement: 题目列表展示

系统 SHALL 在 `/problems` 页面以表格形式展示题目列表，题号列改为 display_id。

#### Scenario: 题号列显示 display_id
- **WHEN** 用户访问 `/problems` 页面
- **THEN** 题号列显示 display_id（如 P1001、U42）而非原始 id

### Requirement: 按类型筛选

系统 SHALL 提供类型筛选控件，支持"全部"、"U（用户题）"、"P（专题）"三个选项。
筛选值 SHALL 通过 URL 参数 `type` 反映。

#### Scenario: 按类型筛选
- **WHEN** 用户选择类型 "U"
- **THEN** 系统发起 `GET /api/v1/problems?type=U` 请求

#### Scenario: 筛选后显示类型标签
- **WHEN** 题目列表加载完成
- **THEN** 每行显示类型标签（U 或 P）
