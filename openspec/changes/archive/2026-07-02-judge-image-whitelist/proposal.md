## Why

当前 `judge_image` 字段为自由文本输入，无任何白名单校验。任何用户创建题目时可以指定任意 Docker 镜像名，存在安全风险——恶意用户可能指定包含漏洞或未授权软件的镜像。需要在管理后台建立镜像白名单机制，确保只有经过管理员批准的镜像才能用于题目评测。

## What Changes

- **新增**：`judge_images` 数据库表，存储白名单镜像配置（镜像名、匹配模式、介绍）
- **新增**：管理员 CRUD API（`GET/POST/PUT/DELETE /api/v1/admin/judge-images`），在后台配置白名单
- **新增**：公开 API `GET /api/v1/judge-images`，返回可用镜像列表及介绍，供题目编辑器下拉框使用
- **新增**：管理后台"评测镜像管理"页面，使用 AdminTable 模式
- **修改**：题目创建/更新 API 增加 `judge_image` 白名单校验——白名单非空时拒绝不在白名单中的镜像
- **修改**：ProblemEditor.vue 将 `judge_image` 从自由文本输入改为下拉选择框（含镜像介绍），列表来自 `GET /api/v1/judge-images`
- **新增**：两种白名单匹配模式——`exact`（指定版本精确匹配）和 `all_versions`（匹配该镜像的所有版本标签）；选择 `all_versions` 时向管理员展示安全风险警告

## Capabilities

### New Capabilities

- `judge-image-whitelist`: 评测镜像白名单管理——管理员配置允许使用的 Docker 镜像，含精确版本和全版本两种匹配模式；题目创建/编辑时从白名单中选择镜像

### Modified Capabilities

- `problem-management`: 题目创建和更新接口增加 `judge_image` 白名单校验——白名单非空时 MUST 验证镜像名是否在允许列表中

## Impact

- **数据库**：新增 `judge_images` 表（id, image, mode, description, created_at, updated_at）
- **noj-core**：新增 `src/routes/admin.ts` 路由（judge-images CRUD）、新增 `src/services/judge-images.ts`、修改 `src/services/problems.ts`（白名单校验）、新增 `src/routes/problems.ts` 公开列表路由
- **noj-ui**：新增 `pages/admin/judge-images.vue`、修改 `components/ProblemEditor.vue`（下拉替换自由输入）
- **安全**：白名单为空时保持向后兼容（不限制任何镜像）；白名单非空时强制执行校验
