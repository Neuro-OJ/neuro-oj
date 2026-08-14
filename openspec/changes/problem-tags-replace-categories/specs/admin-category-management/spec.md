## REMOVED Requirements

### Requirement: 管理员可查看和创建分类

**Reason**: `/admin/categories` 页面退役，由 `/admin/tags` 标签管理页（`admin-tag-management`）取代。

**Migration**: 使用 `/admin/tags` 管理标签。

### Requirement: 管理员可编辑分类

**Reason**: 同上，分类管理页面退役。

**Migration**: 在 `/admin/tags` 中重命名标签或修改 kind。

### Requirement: 管理员可删除分类

**Reason**: 同上，分类管理页面退役。

**Migration**: 在 `/admin/tags` 中删除/合并标签。
