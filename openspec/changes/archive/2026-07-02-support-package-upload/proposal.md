## Why

题目编辑器当前缺少支持包上传功能。用户创建题目后，支持包（含 evaluate.py、测试用例等）只能通过本地 CLI 工具 `build-packages.ts` 手动构建并放置到服务器文件系统，无法通过 Web 界面完成。这导致题目创建流程断裂——管理员必须具有服务器文件系统访问权限才能部署支持包，严重限制了平台的独立运营能力。

## What Changes

- **新增**：支持包上传 API（`POST /api/v1/problems/:id/support-package`），接受 multipart/form-data 上传 zip 文件
- **新增**：支持包删除 API（`DELETE /api/v1/problems/:id/support-package`），允许清空已上传的支持包
- **新增**：题目编辑器中增加支持包上传 UI 区域，含文件选择、拖拽上传、上传状态显示
- **新增**：支持包文件结构引导文档，说明 zip 内应包含的文件和格式要求（无顶级文件夹，直接存放 evaluate.py 等文件）
- **修改**：题目详情/编辑接口返回 `support_package_path` 及上传状态信息，供 UI 展示
- **修改**：ProblemEditor.vue 增加支持包管理功能（上传、替换、删除、状态指示）

## Capabilities

### New Capabilities

- `support-package-upload`: 支持包上传与管理——通过 Web API 上传题目的评测支持包（zip），含文件结构验证、大小限制、存储管理。支持包是题目评测所必需的 zip 文件，内含 evaluate.py 和测试数据。

### Modified Capabilities

- `problem-management`: 题目创建和编辑流程增加支持包管理能力——创建题目后可上传支持包，编辑题目时可替换或删除支持包。

## Impact

- **noj-core**: 新增上传路由（`src/routes/problems.ts`）、新增文件存储服务（`src/services/support-package.ts`）、Hono multipart 解析
- **noj-ui**: 修改 ProblemEditor.vue（增加上传区域）、新增 SupportPackageUpload.vue 组件
- **数据库**: 无 schema 变更（`support_package_path` 字段已存在）
- **存储**: 上传文件存储至 `data/packages/<problem_id>.zip`
- **安全**: 需文件类型验证（仅 .zip）、大小限制（最大 16MB，考虑 Redis MQ 16MB 限制和 Base64 编码开销）、路径穿越防护
