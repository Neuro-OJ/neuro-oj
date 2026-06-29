## Purpose

管理后台题目管理页面增量更新：列表新增 display_id、type、owner 列，
创建/编辑表单适配 U/P 类型。

## MODIFIED Requirements

### Requirement: 管理员可查看题目列表

系统 SHALL 在 `/admin/problems` 路径以表格形式展示所有题目，含 display_id、类型、所有者字段。

#### Scenario: 管理员访问题目管理
- **WHEN** 已登录管理员访问 `/admin/problems`
- **THEN** 系统显示题目列表，包含 display_id（如 P1001）、标题、类型（U/P 标签）、所有者、难度、分类、创建时间等字段

### Requirement: 管理员可创建题目

系统 SHALL 在 `/admin/problems/new` 路径提供创建题目表单，包含类型选择器和题号输入。

#### Scenario: 管理员创建 P 型题目
- **WHEN** 管理员选择类型为"专题（P）"，填写题号 1001 及其他字段并提交
- **THEN** 系统调用 `POST /api/v1/problems` 创建 P 型题目，成功后跳转

#### Scenario: 管理员创建 U 型题目
- **WHEN** 管理员选择类型为"用户题（U）"，不填题号
- **THEN** 系统自动分配 number

#### Scenario: 管理员编辑题目
- **WHEN** 管理员编辑已有题目
- **THEN** 类型和题号显示为只读标签，不可修改
