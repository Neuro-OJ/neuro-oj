# Support Package Upload

## REMOVED Requirements

### Requirement: 支持包上传

**Reason**: 上传端点 `POST /api/v1/problems/:id/support-package` 移除——统一题目包机制（`problem-bundle-import`）上线后，该端点只是 `POST /api/v1/problems/import-bundle` 的受限形态（manifest 必填 + `manifest.id === :id` + 题目必须存在），保留即冗余导入路径。支持包下载（GET）与删除（DELETE）端点保留。

**Migration**: 上传评测内容统一使用 `POST /api/v1/problems/import-bundle`：manifest 含 `id` 且与既有题目匹配时即为更新（替换评测包 + 更新元数据）；新客户端应携带根级含 `problem.json`/`evaluate.py` 的统一题目包。存储语义同步变更：系统剥离 `problem.json`/`statement.md` 后存储纯净评测包（`support_package_storage_url` 指向剥离后包，local 模式落盘到独立存储目录默认 `data/storage/`）。
