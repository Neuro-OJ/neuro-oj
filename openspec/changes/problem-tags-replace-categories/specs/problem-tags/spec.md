## ADDED Requirements

### Requirement: 标签数据模型

系统 SHALL 提供 `tags` 表（id TEXT PK / name TEXT NOT NULL UNIQUE / kind TEXT NOT NULL CHECK in ('problem','algorithm') / created_at TEXT NOT NULL / updated_at TEXT NOT NULL）与 `problem_tags` 多对多关联表（problem_id FK→problems ON DELETE CASCADE + tag_id FK→tags ON DELETE CASCADE，复合主键 (problem_id, tag_id)）。

标签 name SHALL 全局唯一（跨 kind）；kind 区分「题目标签（problem，人人可见）」与「算法标签（algorithm，通过题目后可见）」。

#### Scenario: 重复标签名被拒

- **WHEN** 任何 SQL 尝试插入与已有标签相同 name 的记录
- **THEN** 数据库返回 UNIQUE 约束冲突

#### Scenario: 非法 kind 被拒

- **WHEN** 任何 SQL 尝试插入 kind 不在 ('problem','algorithm') 内的记录
- **THEN** 数据库返回 CHECK 约束冲突

#### Scenario: 删除题目级联清理关联

- **WHEN** 删除一条存在标签关联的题目
- **THEN** `problem_tags` 中该题目的关联行被级联删除

#### Scenario: 删除标签级联清理关联

- **WHEN** 删除一个被题目使用的标签
- **THEN** `problem_tags` 中该标签的关联行被级联删除，题目本身不受影响

### Requirement: 公开标签列表 API

系统 SHALL 提供 `GET /api/v1/tags`，公开返回全部标签（每项含 `id`/`name`/`kind`/`problem_count`，按 name 升序），供列表筛选器与题目编辑器、标签管理页使用。算法标签名对所有人可见（筛选/搜索发现路径，见门控要求）。

#### Scenario: 获取全部标签

- **WHEN** 任何用户请求 `GET /api/v1/tags`
- **THEN** 系统返回全部标签数组，每项含 `id`、`name`、`kind`、`problem_count`（关联题目数）字段，按 name 升序排列

### Requirement: 标签写操作受 tag:manage 权限保护

系统 SHALL 提供 `POST /api/v1/tags`（body: `{name, kind}`）、`PUT /api/v1/tags/:id`（改名/改 kind）、`DELETE /api/v1/tags/:id`，仅拥有 `tag:manage` 权限的用户可调用（RBAC 判定，非硬编码 admin；该权限默认不授予任何角色、仅 admin 隐式拥有，运营者可经角色管理授予自定义角色）；删除时系统 SHALL 写入 `tags.delete` 审计记录。

#### Scenario: 管理员创建标签

- **WHEN** 管理员发送 `POST /api/v1/tags` 并传入 `{"name": "图论", "kind": "algorithm"}`
- **THEN** 系统创建标签并返回 201

#### Scenario: 创建重名标签

- **WHEN** 管理员创建标签时使用已存在的 name
- **THEN** 系统返回 HTTP 409

#### Scenario: 创建非法 kind

- **WHEN** 管理员创建标签时 kind 不在 problem/algorithm 内
- **THEN** 系统返回 HTTP 400

#### Scenario: 普通用户创建标签

- **WHEN** 默认角色（无 `tag:manage` 权限）的用户调用 `POST /api/v1/tags`
- **THEN** 系统返回 HTTP 403

#### Scenario: 自定义角色被授予 tag:manage 后可创建标签

- **WHEN** 运营者将 `tag:manage` 权限授予某自定义角色后，该角色用户调用 `POST /api/v1/tags`
- **THEN** 系统创建标签并返回 201

#### Scenario: 管理员删除标签

- **WHEN** 管理员调用 `DELETE /api/v1/tags/:id`
- **THEN** 系统删除标签、级联清理关联并返回 204，审计日志出现 `action=tags.delete` 记录

#### Scenario: 删除不存在的标签

- **WHEN** 管理员删除不存在的标签
- **THEN** 系统返回 HTTP 404

### Requirement: 标签合并 API

系统 SHALL 提供 `POST /api/v1/tags/:id/merge`（body: `{target_id}`），仅拥有 `tag:manage` 权限的用户可调用（默认仅 admin，可经角色授权配置）。合并在单事务内完成：将 source 标签的全部 `problem_tags` 关联重指向 target（先删除与 target 冲突的重复关联，再重指向剩余关联）→ 删除 source → 写入 `tags.merge` 审计。合并结果保留 target 的 name 与 kind。

#### Scenario: 合并成功

- **WHEN** 管理员调用 `POST /api/v1/tags/<source>/merge` 并传入 `{"target_id": "<target>"}`
- **THEN** 原关联到 source 的题目全部改关联到 target，source 被删除，审计日志出现 `action=tags.merge` 记录

#### Scenario: 题目同时关联两个标签时合并去重

- **WHEN** 某题目同时关联 source 与 target 后执行合并
- **THEN** 合并后该题目仅保留一条关联（不产生重复行、不报错）

#### Scenario: 合并到自身

- **WHEN** 管理员将标签合并到自身（source == target）
- **THEN** 系统返回 HTTP 400

#### Scenario: 合并不存在的标签

- **WHEN** 管理员调用 `POST /api/v1/tags/nonexistent/merge`
- **THEN** 系统返回 HTTP 404

#### Scenario: 跨 kind 合并

- **WHEN** 管理员将算法标签合并进题目标签（或反之）
- **THEN** 关联题目统一指向 target，语义以 target 的 kind 为准（如并入题目标签后原算法标签关联变为人人可见，由 admin 自行承担语义变化）

### Requirement: 题目打标签/去标签

系统 SHALL 在题目创建/更新时通过 `tag_ids` 数组指定标签（全量替换语义），并持久化到 `problem_tags` 关联表。打标签权限沿用题目写权限（admin 与 U 型题 owner）。标签必须已存在（由拥有 `tag:manage` 权限的用户预先创建，默认仅 admin）。客观题（`is_objective=true`）SHALL NOT 关联算法标签。

#### Scenario: 创建题目时关联标签

- **WHEN** admin 或 U 型题 owner 创建题目时传入 `tag_ids: ["<id1>", "<id2>"]`
- **THEN** 系统创建题目并建立与这些标签的关联

#### Scenario: 更新题目时替换标签

- **WHEN** 有写权限的用户更新题目时传入新的 `tag_ids`
- **THEN** 系统删除旧关联并建立新关联

#### Scenario: 关联不存在的标签

- **WHEN** 用户传入包含不存在标签 ID 的 `tag_ids`
- **THEN** 系统返回 HTTP 400

#### Scenario: 客观题关联算法标签被拒

- **WHEN** 用户为 `is_objective=true` 的题目传入包含 kind='algorithm' 标签的 `tag_ids`
- **THEN** 系统返回 HTTP 400，且不写入任何标签关联

### Requirement: 算法标签可视性门控

题目详情接口 SHALL 按 viewer 裁剪标签：kind='problem' 的标签始终返回；kind='algorithm' 的标签仅当 viewer 为 admin、题目 owner 或在该题存在 `evaluation_results.status='Accepted'` 的本人提交时返回。其余 viewer SHALL NOT 收到算法标签的名称与数量。响应 SHALL 始终包含布尔字段 `has_hidden_algorithm_tags`：当存在被隐藏的算法标签时为 true，其余情况（无算法标签或已可见）为 false。客观题（`is_objective=true`）不允许关联算法标签（见打标校验），门控规则仅适用于 U/P 型题目。可视性按请求时最新提交状态实时计算。

#### Scenario: 匿名用户查看题目详情

- **WHEN** 未登录用户请求 `GET /api/v1/problems/:id`（题目含算法标签）
- **THEN** 响应 `tags` 仅含题目标签，`has_hidden_algorithm_tags=true`，响应中不出现任何算法标签名

#### Scenario: 未通过用户查看题目详情

- **WHEN** 无 Accepted 提交的登录用户请求题目详情
- **THEN** 响应 `tags` 仅含题目标签，`has_hidden_algorithm_tags=true`

#### Scenario: 通过用户查看题目详情

- **WHEN** 存在 Accepted 提交的登录用户请求题目详情
- **THEN** 响应 `tags` 包含题目标签与算法标签，`has_hidden_algorithm_tags=false`

#### Scenario: 无算法标签的题目

- **WHEN** 任何用户请求一个仅含题目标签的题目详情
- **THEN** 响应 `tags` 返回全部题目标签，`has_hidden_algorithm_tags=false`

#### Scenario: admin 与题主始终可见

- **WHEN** admin 或题目 owner 请求题目详情
- **THEN** 响应 `tags` 包含全部标签（含算法标签），`has_hidden_algorithm_tags=false`

### Requirement: 列表接口仅返回题目标签

题目列表/卡片类接口（`GET /api/v1/problems` 等）SHALL 只附带 kind='problem' 的标签，不返回算法标签，也不返回 `has_hidden_algorithm_tags` 标志。

#### Scenario: 列表响应不含算法标签

- **WHEN** 任何用户请求 `GET /api/v1/problems`
- **THEN** 每题 `tags` 数组仅含 kind='problem' 的标签

### Requirement: 按标签筛选题目

系统 SHALL 在 `GET /api/v1/problems` 上支持 `tag` 查询参数（单选，值为标签 ID），与 `difficulty`/`keyword`/`type`/`number`/`owner_id` 参数 AND 叠加。算法标签同样可用于筛选（发现路径，接受反向暴露）。

#### Scenario: 按标签筛选

- **WHEN** 用户请求 `GET /api/v1/problems?tag=<tag-id>`
- **THEN** 系统仅返回关联该标签的题目

#### Scenario: 标签与难度组合筛选

- **WHEN** 用户请求 `GET /api/v1/problems?tag=<tag-id>&difficulty=easy`
- **THEN** 系统返回同时关联该标签且难度为 easy 的题目

#### Scenario: 无题目关联的标签

- **WHEN** 用户按一个无题目关联的标签筛选
- **THEN** 系统返回空列表（total=0）

### Requirement: 全局搜索匹配标签名

系统 SHALL 使题目搜索（`GET /api/v1/search?type=problem`）匹配标签名：当搜索词命中题目标签或算法标签的 name 时返回对应题目。搜索响应结构不变。

#### Scenario: 搜索命中标签名

- **WHEN** 用户搜索词命中某标签 name（如「图论」）
- **THEN** 搜索结果包含关联该标签的题目

#### Scenario: 搜索未命中标签名

- **WHEN** 搜索词不匹配任何标题、题号或标签名
- **THEN** 搜索结果为空
