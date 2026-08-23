# objective-questions Specification

## Purpose
定义客观题卷与小题的管理：套卷 CRUD、小题 CRUD、答案可见性控制。
## Requirements
### Requirement: 客观题卷管理

系统 SHALL 提供客观题卷（套卷）的创建、编辑、删除与列表查询。套卷 SHALL 复用 problems 表（is_objective=true），使用 `display_id`（如 `U1001`）对外展示；创建时 SHALL 不要求 `runtime_config`。

套卷权限 SHALL 随题目 type：U 型 owner / admin 可 CRUD；P 型仅 admin；普通用户可查看题面。

#### Scenario: 普通用户创建套卷
- **WHEN** 普通用户发送 `POST /api/v1/problems` 携带 is_objective=true、title、description 且不含 runtime_config
- **THEN** 系统创建 客观题套卷，自动设 owner_id 为当前用户，自动分配 number，返回 201

#### Scenario: 题库列表中的套卷标记
- **WHEN** 用户请求 `GET /api/v1/problems` 题目列表
- **THEN** 客观题套卷条目在难度位置以「客观题」标记展示（无独立题库入口）

#### Scenario: 套卷按 display_id 查找
- **WHEN** 用户请求 `GET /api/v1/problems/U1001`
- **THEN** 系统通过双索引解析返回该套卷详情

#### Scenario: 非 owner 编辑套卷被拒
- **WHEN** 普通用户编辑他人所有的 客观题套卷
- **THEN** 系统返回 HTTP 403

#### Scenario: owner 删除套卷
- **WHEN** 套卷 owner 调用 `DELETE /api/v1/problems/:id`
- **THEN** 系统删除套卷及其全部小题与客观题提交记录（FK 级联），返回 204

### Requirement: 小题管理

系统 SHALL 提供客观题小题的创建、编辑、删除与列表查询。小题 SHALL 必须绑定所属套卷（`paper_id` 外键），不可孤立创建或存在。

小题形态 SHALL 支持三种类型：
- `single` 单选：标准答案恰好一个选项
- `multiple` 多选：标准答案为一个选项集合（判分须完全匹配）
- `judge` 判断：标准答案为 true / false

小题 SHALL 包含题干（prompt）、选项列表（options，judge 型可空）、标准答案（answer）、可选解析（explanation），并按 sort_order 排序展示。

#### Scenario: 套卷下创建单选小题
- **WHEN** owner 发送 `POST /api/v1/problems/:id/questions` 携带 type='single'、prompt、options（A/B/C/D）与 answer=['A']
- **THEN** 系统创建小题并绑定该套卷，返回 201

#### Scenario: 创建多选小题
- **WHEN** owner 创建 type='multiple' 小题且 answer=['A','C']
- **THEN** 系统保存标准答案为集合 ['A','C']，判分时要求完全匹配

#### Scenario: 创建判断题
- **WHEN** owner 创建 type='judge' 小题且 answer=[true]
- **THEN** 系统保存判断题，选项固定为对/错

#### Scenario: 小题无法脱离套卷存在
- **WHEN** 用户尝试提交不携带 paper_id 的小题创建请求
- **THEN** 系统返回 HTTP 400

#### Scenario: 非 owner 管理小题被拒
- **WHEN** 普通用户对他人 U 型套卷、或任意非 admin 用户对 P 型套卷创建/编辑/删除小题
- **THEN** 系统返回 HTTP 403

#### Scenario: 删除套卷级联删除小题
- **WHEN** 套卷被删除
- **THEN** 该卷下全部小题随外键级联删除

### Requirement: 答案可见性控制

系统 SHALL 保证客观题标准答案与解析仅在授权场景下可见：U 型套卷 owner / admin、P 型套卷仅 admin 可在小题管理视图可见；普通用户在答题视图 SHALL 不可见答案与解析字段。

#### Scenario: 公开视图裁剪答案
- **WHEN** 非 owner 用户获取套卷小题列表（答题页数据）
- **THEN** 响应不含 answer 与 explanation 字段

#### Scenario: owner 视图含答案
- **WHEN** 套卷 owner 或 admin 获取小题列表
- **THEN** 响应包含 answer 与 explanation 字段

### Requirement: 套卷创建后添加小题并持久化展示

系统 SHALL 保证用户在创建客观题套卷后，可以继续添加小题，且添加后重新加载/刷新页面时小题仍然保留。

#### Scenario: 创建套卷后添加小题并刷新保留

- **WHEN** 用户创建客观题套卷，随后添加一道小题并刷新页面
- **THEN** 该套卷详情仍包含刚添加的小题，小题数据已持久化

#### Scenario: 添加小题后列表立即刷新

- **WHEN** 用户在套卷编辑页保存一道小题
- **THEN** 页面小题列表立即出现该小题，无需手动刷新

#### Scenario: 小题保存失败有明确错误

- **WHEN** 用户提交的小题数据不合法（如缺少题干、选项不足、未选答案）
- **THEN** 系统不写入数据，并向前端返回明确错误提示

