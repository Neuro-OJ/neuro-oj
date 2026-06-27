## Purpose

定义 Neuro OJ 管理后台题目管理页面规范。该页面在 `/admin/problems` 路径提供，允许管理员管理题目。

## Requirements

### Requirement: 管理员可查看题目列表

系统 SHALL 在 `/admin/problems` 路径提供题目管理页面，以表格形式展示所有题目（含 U 型和 P 型），含 display_id、类型、所有者字段。

后端提供 `GET /api/v1/admin/problems` 端点，依次通过 `authMiddleware` 和 `adminMiddleware` 保护，返回全量题目列表（不默认筛选 type='P'），额外返回 `owner_username` 字段。

#### Scenario: 管理员访问题目管理
- **WHEN** 已登录管理员访问 `/admin/problems`
- **THEN** 系统显示题目列表，包含 display_id（如 P1001）、标题、类型（U/P 标签）、所有者、难度、分类、创建时间等字段

#### Scenario: 管理员列表支持分页和筛选
- **WHEN** 管理员调用 `GET /api/v1/admin/problems?page=1&limit=20&difficulty=easy`
- **THEN** 系统返回分页的题目列表，支持与普通列表相同的 difficulty、keyword、category_id 筛选参数

#### Scenario: 非管理员拒绝访问
- **WHEN** 普通用户调用 `GET /api/v1/admin/problems`
- **THEN** 系统返回 HTTP 403

### Requirement: 管理员可创建题目

系统 SHALL 在 `/admin/problems/new` 路径提供创建题目表单，包含类型选择器和题号输入。

#### Scenario: 管理员创建 P 型题目指定题号
- **WHEN** 管理员选择类型为"专题（P）"，填写题号 1001 及其他字段并提交
- **THEN** 系统调用 `POST /api/v1/problems` 创建 P 型题目，成功后跳转

#### Scenario: 管理员创建 U 型题目
- **WHEN** 管理员选择类型为"用户题（U）"，不填题号
- **THEN** 系统自动分配 number，创建 U 型题目

#### Scenario: 创建题目时必填字段为空

- **WHEN** 管理员提交表单时必填字段（如标题）为空
- **THEN** 系统在前端显示字段级验证错误，不提交表单

#### Scenario: 创建题目时 API 返回错误

- **WHEN** 提交创建题目前端验证通过但 API 返回业务错误
- **THEN** 系统显示服务端错误提示，表单数据不丢失

### Requirement: 管理员可编辑题目

系统 SHALL 在 `/admin/problems/:id/edit` 路径提供编辑题目表单，预填充已有数据。

#### Scenario: 管理员成功编辑题目
- **WHEN** 管理员修改题目字段并提交
- **THEN** 系统调用 `PUT /api/v1/problems/:id`，成功后跳转到题目列表页并显示成功消息

#### Scenario: 编辑页面显示类型和题号只读
- **WHEN** 管理员访问编辑页面
- **THEN** 类型和题号以只读标签展示，不可修改

#### Scenario: 管理员编辑不存在的题目

- **WHEN** 管理员访问 `/admin/problems/:id/edit` 时题目 ID 不存在
- **THEN** 系统显示 404 或错误提示

### Requirement: 管理员可删除题目

系统 SHALL 允许管理员在题目列表中删除题目，删除前需确认。

#### Scenario: 管理员成功删除题目

- **WHEN** 管理员在题目列表点击删除按钮，在确认弹窗中点击确认
- **THEN** 系统调用 `DELETE /api/v1/problems/:id`，成功后从列表中移除该题目

#### Scenario: 管理员取消删除题目

- **WHEN** 管理员在确认弹窗中点击取消
- **THEN** 系统关闭弹窗，题目不被删除
