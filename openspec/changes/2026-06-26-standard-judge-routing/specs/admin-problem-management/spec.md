## Purpose

管理后台题目管理规范增量更新：创建/编辑表单新增判题类型下拉（标准题 / SPJ 题）。

## MODIFIED Requirements

### Requirement: 管理员可创建题目

系统 SHALL 在创建题目表单中提供判题类型下拉选择器。

#### Scenario: 管理员创建标准题

- **WHEN** 管理员选择判题类型为"标准题（stdout diff）"，填写其他字段并提交
- **THEN** 系统调用 `POST /api/v1/problems` 携带 `judge_type: "standard"`，成功后跳转

#### Scenario: 管理员创建 SPJ 题

- **WHEN** 管理员选择判题类型为"SPJ 题（自定义 evaluate.py）"，填写其他字段并提交
- **THEN** 系统调用 `POST /api/v1/problems` 携带 `judge_type: "special"`，成功后跳转

#### Scenario: 默认判题类型

- **WHEN** 管理员打开创建表单，未修改判题类型字段
- **THEN** 默认值为"SPJ 题"（`special`），保持向后兼容

### Requirement: 管理员可编辑题目

系统 SHALL 在编辑表单中显示并允许修改判题类型字段。

#### Scenario: 加载已有题目

- **WHEN** 管理员打开已有题目的编辑页
- **THEN** 判题类型下拉显示当前 problem 的 `judge_type` 值

#### Scenario: 修改判题类型

- **WHEN** 管理员将判题类型从"标准题"切换为"SPJ 题"，保存
- **THEN** 系统调用 `PUT /api/v1/problems/:id` 携带新的 `judge_type`，更新成功

#### Scenario: 客户端校验

- **WHEN** 客户端提交非法 `judge_type` 值
- **THEN** 前端校验失败，提示错误并不发送请求