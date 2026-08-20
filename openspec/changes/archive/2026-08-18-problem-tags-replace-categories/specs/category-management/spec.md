## REMOVED Requirements

### Requirement: 系统可返回分类树

**Reason**: 分类树系统整体退役，由双类标签系统（`problem-tags`）取代。

**Migration**: 使用 `GET /api/v1/tags` 获取标签列表；分类的树形层级不再保留。

### Requirement: 管理员可创建分类

**Reason**: 分类 CRUD 退役，由标签 CRUD 取代。

**Migration**: 使用 `POST /api/v1/tags`（body `{name, kind}`）创建标签。

### Requirement: 管理员可更新分类

**Reason**: 分类 CRUD 退役，由标签 CRUD 取代。

**Migration**: 使用 `PUT /api/v1/tags/:id` 修改标签名称或 kind。

### Requirement: 管理员可删除分类

**Reason**: 分类 CRUD 退役，由标签 CRUD 取代。

**Migration**: 使用 `DELETE /api/v1/tags/:id` 删除标签（级联清理关联）；合并语义由 `POST /api/v1/tags/:id/merge` 提供。

### Requirement: 题目可与多个分类关联

**Reason**: 题目-分类关联退役，由题目-标签关联（`tag_ids` 全量替换）取代。

**Migration**: 题目创建/更新载荷使用 `tag_ids` 数组；关联表为 `problem_tags`。
