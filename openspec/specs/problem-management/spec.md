## Purpose

定义 Neuro OJ 题目管理系统规范，包括题目 CRUD、多维度筛选与分页、难度约束。
管理员可管理题目，普通用户可查看和筛选。

## Requirements

### Requirement: 用户可创建题目

系统 SHALL 提供 `POST /api/v1/problems`，管理员可创建任意 type 的题目，
普通用户可创建 type='U' 的题目（自动成为所有者）。

#### Scenario: 管理员成功创建 P 型题目
- **WHEN** 管理员发送 `POST /api/v1/problems` 并携带 type='P' 及有效字段
- **THEN** 系统创建 P 型题目并返回 201

#### Scenario: 普通用户成功创建 U 型题目
- **WHEN** 普通用户发送 `POST /api/v1/problems` 并携带 type='U' 及有效字段
- **THEN** 系统创建 U 型题目，自动设 owner_id 为当前用户，自动分配 number，返回 201

#### Scenario: 普通用户尝试创建 P 型题目
- **WHEN** 普通用户调用 `POST /api/v1/problems` 并携带 type='P'
- **THEN** 系统返回 HTTP 403

#### Scenario: 创建题目时不传 type 默认 U
- **WHEN** 用户发送 `POST /api/v1/problems` 且未传 type 字段
- **THEN** 系统默认 type='U'

#### Scenario: 缺少必填字段
- **WHEN** 用户创建题目时缺少 `title`、`judge_image` 或 `judge_command`
- **THEN** 系统返回 HTTP 400，提示缺少必填字段

#### Scenario: 非法难度值
- **WHEN** 用户创建题目时传入 `difficulty: "expert"`
- **THEN** 系统返回 HTTP 400，提示难度值仅允许 easy/medium/hard

### Requirement: 用户可更新题目

系统 SHALL 提供 `PUT /api/v1/problems/:id`，权限基于 type + owner 判断。

#### Scenario: 管理员成功更新题目
- **WHEN** 管理员发送 `PUT /api/v1/problems/:id` 并携带有效字段
- **THEN** 系统更新题目并返回更新后的题目详情

#### Scenario: U 型所有者更新自己题目
- **WHEN** 普通用户发送 `PUT /api/v1/problems/:id` 更新自己所有的 U 型题目
- **THEN** 系统允许更新

#### Scenario: U 型非所有者更新被拒
- **WHEN** 普通用户更新他人所有的 U 型题目
- **THEN** 系统返回 HTTP 403

#### Scenario: 普通用户更新 P 型被拒
- **WHEN** 普通用户更新 P 型题目
- **THEN** 系统返回 HTTP 403

#### Scenario: type 和 number 不可变更
- **WHEN** 任何用户更新题目时尝试修改 type 或 number
- **THEN** 系统忽略这两个字段的变更

#### Scenario: 更新不存在的题目
- **WHEN** 用户更新 `PUT /api/v1/problems/nonexistent`
- **THEN** 系统返回 HTTP 404

### Requirement: 用户可删除题目

系统 SHALL 提供 `DELETE /api/v1/problems/:id`。U 型所有者可删除自己题目，P 型仅管理员可删除。

#### Scenario: 管理员成功删除题目
- **WHEN** 管理员调用 `DELETE /api/v1/problems/:id`
- **THEN** 系统删除题目及其分类关联并返回 204

#### Scenario: U 型所有者删除自己题目
- **WHEN** 普通用户删除自己所有的 U 型题目
- **THEN** 系统返回 204

#### Scenario: 普通用户删除 P 型被拒
- **WHEN** 普通用户删除 P 型题目
- **THEN** 系统返回 HTTP 403

#### Scenario: 删除不存在的题目
- **WHEN** 管理员删除 `DELETE /api/v1/problems/nonexistent`
- **THEN** 系统返回 HTTP 404

### Requirement: 题目列表支持多维度筛选与分页

系统 SHALL 在 `GET /api/v1/problems` 上支持 `difficulty`、`category_id`、`keyword`、`type`、`number` 查询参数。

#### Scenario: 按难度筛选
- **WHEN** 用户请求 `GET /api/v1/problems?difficulty=easy`
- **THEN** 系统仅返回难度为 easy 的题目

#### Scenario: 按分类筛选
- **WHEN** 用户请求 `GET /api/v1/problems?category_id=<category-id>`
- **THEN** 系统仅返回属于该分类的题目

#### Scenario: 按关键词搜索
- **WHEN** 用户请求 `GET /api/v1/problems?keyword=归一化`
- **THEN** 系统返回标题、描述或题号中包含该关键词的题目

#### Scenario: 按类型筛选
- **WHEN** 用户请求 `GET /api/v1/problems?type=U`
- **THEN** 系统仅返回 U 型题目

#### Scenario: 按题号筛选
- **WHEN** 用户请求 `GET /api/v1/problems?type=P&number=1001`
- **THEN** 系统仅返回 P 型中 number=1001 的题目

#### Scenario: 组合筛选加分页
- **WHEN** 用户请求 `GET /api/v1/problems?difficulty=easy&keyword=归一化&page=1&limit=10`
- **THEN** 系统返回同时满足所有条件的分页结果

#### Scenario: 非法分页参数
- **WHEN** 用户请求 `GET /api/v1/problems?page=abc`
- **THEN** 系统返回 HTTP 400

#### Scenario: display_id 返回
- **WHEN** 用户请求题目列表或详情
- **THEN** 响应中包含 display_id（如 "P1001"）、owner_id、type、number 字段

### Requirement: 数据库强制限制难度取值

系统 SHALL 通过数据库 `CHECK` 约束确保 `problems.difficulty` 仅允许
`'easy'`、`'medium'`、`'hard'`。

#### Scenario: 非法难度写入数据库
- **WHEN** 任何 SQL 尝试写入 `difficulty = 'invalid'`
- **THEN** 数据库返回约束违反错误

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

### Requirement: 题目编辑器提供镜像下拉选择

系统 SHALL 在题目编辑器中将 `judge_image` 字段从自由文本输入改为下拉选择框，选项列表来自 `GET /api/v1/judge-images`。每个选项 SHALL 显示镜像名和管理员配置的介绍。

下拉框中仅展示白名单中的镜像选项。白名单为空时下拉为空，提交时后端校验将拒绝。

#### Scenario: 白名单非空时显示下拉列表

- **WHEN** 白名单中有至少一条记录，用户进入题目编辑器
- **THEN** `judge_image` 字段渲染为下拉选择框，选项包含所有白名单镜像，每项显示镜像名和介绍

#### Scenario: 选择镜像后提交

- **WHEN** 用户从下拉框选择镜像并提交题目
- **THEN** 请求中 `judge_image` 的值为所选镜像的 `image` 字段值

### Requirement: 创建题目时校验镜像白名单（前端）

系统 SHALL 在创建题目时，若当前存在镜像白名单，前端将下拉框限制为仅白名单中的镜像选项。

#### Scenario: 管理员通过下拉框选择镜像创建题目

- **WHEN** 白名单中有 `noj-judge-python` 条目，管理员在题目编辑器中选择该镜像
- **THEN** 创建请求携带 `judge_image: "noj-judge-python"`，后端白名单校验通过，创建成功

#### Scenario: 用户通过下拉框选择镜像创建题目

- **WHEN** 白名单中有多个条目，普通用户在题目编辑器下拉框中选择其中一项
- **THEN** 创建请求携带所选镜像名，后端白名单校验通过，创建成功
