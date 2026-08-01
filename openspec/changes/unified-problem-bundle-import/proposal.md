# Unified Problem Bundle Import

## Why

题目导入机制目前分散在四条互不兼容的路径上：`seed.ts` 硬编码题面与 `runtime_config`、`build-packages.ts` 打包松散 zip、admin 后台上传仅支持包、JSON 导入不含支持包文件。打包规则也不一致——实测 1001.zip 含题面 `README.md` 与 `__pycache__/*.pyc` 垃圾，1002.zip 含参考实现 `submission_sample.py`（泄露进评测容器），1003.zip 才干净。同时 `data/packages/` 目录混用为构建产物输出与 `LocalStorageProvider` 存储后端，导致 90+ 个测试残留 zip 与真实评测包混杂。缺少统一格式、统一校验与单一导入路径。

## What Changes

- **统一题目包（Problem Bundle）格式**：单个 zip 作为导入载体，根级必含 `problem.json`（manifest）与 `evaluate.py`，含 `statement.md`（题面）与任意评测内容（testcase 不标准化，格式由题目自定）。**BREAKING**：无 manifest 的旧式松散支持包 zip 一律拒绝（HTTP 400）。
- **剥离后存储**：导入时 core 读取 `problem.json`/`statement.md` 后从 zip 中剥离，用 `fflate` 重建"纯净评测包"存入 storage（`support_package_storage_url`）；题面/元数据唯一事实来源是数据库，WebUI 编辑题面不会与包内旧快照冲突。
- **统一导入服务与 API**：新增 `POST /api/v1/problems/import-bundle`（multipart zip），解析 manifest → 复用 `createProblem`/`updateProblem` upsert 元数据（分类按名匹配缺省忽略、样例缺省 `extractSamples` 提取）→ 注册评测包；`runtime_config.evaluator.command` 可缺省，默认注入 `python3 /workspace/evaluate.py`。
- **现有支持包上传端点废弃**：`POST /api/v1/problems/:id/support-package` 上传端点移除（**BREAKING**），已有题目评测包替换统一走 `import-bundle`（manifest.id 匹配既有题目即更新）；GET 下载 / DELETE 删除端点保留。
- **JSON 元数据导入导出废弃**：移除 `problems-export/import`（issue #28 的服务层死代码——`buildExportPayload`/`importProblems` 无任何路由挂载），完整题目的备份/迁移一律使用统一包。
- **CLI 工具集重构**：`seed.ts`/`build-packages.ts` 废弃，改为 Cliffy 单入口 `scripts/noj.ts`（子命令 `db migrate`/`init system`/`bootstrap admin`/`problems build`/`problems import`/`dev-setup`），`seed` 字样彻底移除；`dev-setup` 聚合开发环境初始化并填充非生产数据（示例题、E2E 用户）。
- **data 目录整治**：`LocalStorageProvider` 存储根目录与构建产物分离（默认 `data/storage/`，`SUPPORT_PACKAGE_DIR` 覆盖保留）；清空 `data/packages/` 测试残留；删除空壳目录 `data/problems/`；`git rm --cached` 已跟踪的 `__pycache__`。
- **遗留清理**：移除 seed 白名单残留旧单容器镜像 `noj-judge-python`；清理 `legacy 本地路径` 死注释；恢复根目录 `ROADMAP.md`；清理工作区垃圾日志文件。

## Capabilities

### New Capabilities
- `problem-bundle-import`: 统一题目包格式（manifest 校验、根级 `evaluate.py` 强制、ZIP 安全）、剥离后存储、`import-bundle` 导入端点、幂等 upsert 语义。

### Modified Capabilities
- `support-package-upload`: 上传 Requirement 移除（收敛到 `import-bundle`，GET/DELETE 保留）；存储语义从"原样存储"改为"剥离元数据后存储纯净评测包"。
- `problem-runtime-config`: `runtime_config.evaluator.command` 允许缺省，缺省时注入默认值 `python3 /workspace/evaluate.py`。

## Impact

- **noj-core**：新增 `src/services/problem-bundle.ts`、`src/types/problem-bundle.ts`、路由 `import-bundle`、CLI 入口 `scripts/noj.ts`；引入 npm `fflate` 与 jsr `@cliffy/command` 依赖；`src/lib/storage/local.ts` 存储根目录调整；移除 `scripts/seed.ts`、`scripts/build-packages.ts`、`scripts/db/*.sh`、`scripts/build/*.sh` 及 `src/services/problems-export.ts`（含 Export/Import 类型与 re-export）。
- **noj-ui**：admin 题目编辑器上传区改为统一包导入入口与引导文案。
- **数据目录**：`data/problems-src/<id>/`（+`problem.json`/`statement.md`）、`data/packages/`（仅构建产物）、`data/storage/`（新，storage 后端）、删除 `data/problems/`。
- **deno.json tasks**：`seed`/`build-packages`/`setup` 移除，新增 `db:migrate`/`init:system`/`bootstrap:admin`/`problems:build`/`problems:import`/`dev-setup`。
- **noj-judge**：零改动（评测包解压到 `/workspace` 后 `evaluate.py` 仍在根级）。
- **规范文档**：`support-package-upload`、`problem-runtime-config` 增量更新；包格式规范成文供 noj-docs 引用。
