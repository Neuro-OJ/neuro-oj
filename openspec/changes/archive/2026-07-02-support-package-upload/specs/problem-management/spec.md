## ADDED Requirements

### Requirement: 题目编辑器支持上传管理支持包

系统 SHALL 在题目编辑界面（ProblemEditor 组件）中集成支持包上传功能，允许用户在创建或编辑题目时上传、替换、删除支持包。

创建模式下，上传区域在题目首次保存后激活（题目已有 ID）。编辑模式下，上传区域始终可用。

#### Scenario: 创建题目后上传支持包

- **WHEN** 用户在创建模式下成功保存题目后，点击上传区域选择 zip 文件
- **THEN** 系统调用 `POST /api/v1/problems/:id/support-package` 上传文件，UI 显示上传成功及文件名

#### Scenario: 编辑题目时替换支持包

- **WHEN** 题目已有支持包，用户在编辑模式下上传新 zip 文件
- **THEN** 系统覆盖旧支持包，UI 更新显示新文件名

#### Scenario: 编辑题目时删除支持包

- **WHEN** 题目已有支持包，用户点击删除按钮并确认
- **THEN** 系统调用 `DELETE /api/v1/problems/:id/support-package`，UI 恢复为"未上传"状态

#### Scenario: 未保存题目时上传区域不可用

- **WHEN** 用户在创建模式下尚未保存题目
- **THEN** 上传区域显示提示"请先保存题目后再上传支持包"，上传功能禁用

#### Scenario: 上传非 zip 文件时显示错误

- **WHEN** 用户选择非 .zip 文件（前端验证）
- **THEN** 文件选择器拒绝该文件，提示"仅支持 .zip 格式"
