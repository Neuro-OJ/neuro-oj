# Unified Problem Bundle Import — Tasks

## 1. 包格式类型与校验

- [x] 1.1 在 `noj-core/src/types/problem-bundle.ts` 定义 `ProblemBundleManifest` 接口（`format_version`/`id?`/`number?`/`title`/`difficulty?`/`type?`/`description?`/`categories?`/`samples?`/`runtime_config`）与 `BUNDLE_FORMAT_VERSION = 1` 常量
- [x] 1.2 实现 `validateBundleManifest(manifest)`：必填字段（`format_version`/`title`/`runtime_config`）缺失、`difficulty`/`type` 非法、`runtime_config` 未通过 `validateRuntimeConfig` 时抛出 `BadRequestError` 并指明字段
- [x] 1.3 实现 `resolveManifestCommand(runtimeConfig)`：`evaluator.command` 缺省时注入默认值 `python3 /workspace/evaluate.py`（对齐 `problem-runtime-config` delta spec）
- [x] 1.4 实现 `isValidProblemBundleName(name)`：仅接受 `.zip` 后缀（供路由层复用现有约定）

## 2. core：zip 解析与剥离存储

- [ ] 2.1 在 `noj-core/deno.json` 引入 npm `fflate` 依赖（`deno cache` 更新锁文件，不手改）
- [ ] 2.2 实现 `src/lib/bundle-parser.ts`：`parseBundleZip(data)` 用 `fflate.unzipSync` 读取 zip 条目，执行 ZIP 安全校验（路径穿越拒绝、条目 ≤1000、单文件 ≤64 MiB、总解压 ≤512 MiB，对齐 judge 端常量），提取 `problem.json`（解析 JSON）与 `statement.md` 内容
- [ ] 2.3 实现 `stripMetadataEntries(data)`：`unzipSync(data, { filter })` 跳过 `problem.json`/`statement.md` 两个固定名条目后用 `zipSync` 重建纯净评测包（`evaluate.py` 保持根级）
- [ ] 2.4 单元测试 `bundle-parser`：合法包解析、缺 manifest、根级缺 `evaluate.py`、路径穿越、炸弹防护、剥离重建后不含元数据条目

## 3. core：统一导入服务与 API

- [ ] 3.1 实现 `src/services/problem-bundle.ts`：`importProblemBundle(data, actor)` 编排 解析 → 校验 manifest → 剥离重建 → `storage.put()` → 复用 `createProblem`/`updateProblem` upsert 元数据（`categories` 按 name 匹配缺省忽略 + warning、`samples` 缺省 `extractSamples`、`id`/`number` 仅 admin 生效）→ 更新 `support_package_storage_url`，返回题目响应
- [ ] 3.2 在 `noj-core/src/routes/problems.ts` 新增 `POST /api/v1/problems/import-bundle`（multipart 字段 `file`；admin 任意 type 可带 `id`/`number`，owner 仅 U 型且忽略；128 MiB 上限；审计日志）
- [ ] 3.3 移除 `POST /api/v1/problems/:id/support-package` 上传端点（删除 handler 与路由注册；GET 下载 / DELETE 删除端点保留），前端/文档同步切换 `import-bundle`
- [ ] 3.4 routes 测试：`import-bundle` 创建/upsert（含 manifest.id 匹配既有题目的替换场景）/权限（admin、owner、非 owner）/400 场景（缺 manifest、根级缺 evaluate.py）；`support-package` 上传端点移除后返回 404 且 GET/DELETE 正常

## 4. data 目录整治

- [ ] 4.1 `src/lib/storage/local.ts`：`PACKAGES_DIR` 从 `data/packages` 改为独立存储目录（默认 `data/storage/`，保留 `SUPPORT_PACKAGE_DIR` 环境变量覆盖），更新文件头注释
- [ ] 4.2 `.gitignore` 补 `noj-core/data/storage/`；`git rm --cached noj-core/data/problems-src/1001/__pycache__/` 移除已跟踪 pyc
- [ ] 4.3 清理 `data/packages/` 存量测试残留 zip（`route-sp-problem-*`/`test-sp-problem-*` 及 hash 命名对象），目录仅保留构建产物角色
- [ ] 4.4 删除空壳目录 `data/problems/`（含 `.gitkeep`）并清理相关引用

## 5. CLI 工具集（Cliffy 单入口，取代 seed/build-packages 脚本）

- [ ] 5.1 引入 `jsr:@cliffy/command` 依赖（`deno add` 更新 deno.json 与锁文件）
- [ ] 5.2 创建 `scripts/noj.ts` 单入口：根 Command（name=noj, description, version）+ 子命令 `db migrate` / `init system` / `bootstrap admin` / `problems build` / `problems import` / `dev-setup` + `help`（HelpCommand）+ `completions`（CompletionsCommand），统一 `--env-file` 与错误退出码约定
- [ ] 5.3 拆分 `seed.ts` 系统基础数据逻辑（`ensureRootUser` + `ensureRbacSeeds` + 镜像白名单 + 分类）→ `noj init system` 子命令（幂等）
- [ ] 5.4 管理员引导（`ensureAdminFromEnv` + `ensureBootstrapAdmin`）→ `noj bootstrap admin` 子命令（支持 `--email`/`--password` 传参）
- [ ] 5.5 题目构建逻辑（`problems-src` → 统一题目包，排除 `submission*`/`__pycache__`/`.git`）→ `noj problems build` 子命令（`--id` 可选，默认全部）
- [ ] 5.6 题目导入逻辑（扫描 `data/packages/*.zip` → `importProblemBundle` 幂等 upsert）→ `noj problems import` 子命令（`--dir` 可选，默认 `data/packages`）
- [ ] 5.7 `noj dev-setup` 子命令：聚合 `db migrate` + `init system` + `bootstrap admin` + `problems build` + `problems import`，并填充 dev 专用数据（1001-1003 示例题、E2E 守卫用户 `ensureE2EPwChangeUser`）
- [ ] 5.8 `deno.json` tasks 重命名：移除 `seed`/`build-packages`/`setup`/`migrate` 旧名（seed 字样彻底消失），新增 `db:migrate`/`init:system`/`bootstrap:admin`/`problems:build`/`problems:import`/`dev-setup`（均指向 `noj.ts` 子命令）；同步更新 `e2e.yml` 与 `noj-core/scripts/e2e-entrypoint.sh` 的调用
- [ ] 5.9 删除 `scripts/db/seed.sh`、`scripts/db/migrate.sh`、`scripts/build/build-packages.sh` 重复封装层；删除 `scripts/seed.ts`、`scripts/build-packages.ts`（逻辑迁入 noj.ts 子命令）
- [ ] 5.10 更新 `openspec/specs/admin-authorization/spec.md`、`openspec/specs/rbac-core/spec.md` 中 `deno task seed` 引用（改为 `init:system`/`bootstrap:admin`/`dev-setup` 语义）；同步 AGENTS.md、noj-core/CLAUDE.md、README.md

## 6. 源目录补齐

- [ ] 6.1 `problems-src/{1001,1002,1003}/` 各补齐 `problem.json`（从 `seed.ts` 迁移 title/difficulty/type/runtime_config；`evaluator.command` 省略以验证默认注入）与 `statement.md`（迁移 description；1001 的 `README.md` 改名并删除旧文件）
- [ ] 6.2 统一参考实现命名：1001 删除多余 `submission.py`，1003 将 `submission.py` 改名 `submission_sample.py`（与配置 `solution.entry` 一致）
- [ ] 6.3 重跑 `deno task problems:build` 并 `unzip -l` 验证：产物含 manifest 与 statement，不含 `submission*`/`__pycache__`；重跑 `deno task dev-setup` 验证：1001-1003 元数据正确、`support_package_storage_url` 指向剥离后评测包、重复运行不产生重复题、不误扫 `data/storage/`

## 7. JSON 导入导出废弃

- [ ] 7.1 删除 `src/services/problems-export.ts`（`buildExportPayload`/`importProblems`）与 `tests/services/problems-export.test.ts`
- [ ] 7.2 从 `src/types/problems.ts` 移除 `ExportPayload`/`ExportProblem`/`ExportQuery`/`ImportStrategy`/`ImportItemResult`/`ImportReport`/`EXPORT_VERSION`（保留 `isValidProblemType` 等被 `createProblem` 复用的校验函数）；清理 `src/services/problems.ts` 的 re-export 与 `problems-list.ts`/`problems-categories.ts` 相关注释
- [ ] 7.3 检查 noj-ui 与 noj-tests 对导出/导入端点或类型无残留引用

## 8. 遗留清理（B 类）

- [ ] 8.1 移除 `init:system` 中残留旧单容器镜像 `noj-judge-python`（白名单仅保留 `noj-evaluator-python`/`noj-solution-python`）
- [ ] 8.2 核实并清理 `legacy 本地路径` 死注释（`src/db/schema.ts`、`src/lib/storage/types.ts`）：确认无实际处理分支后修正注释
- [ ] 8.3 核对 `openspec/changes/archive/2026-07-25-container-pool-superseded/README.md` 与 `main.rs` 现状（PoolManager 仍在使用）；不一致则修正归档 README 说明；同步核对 `problem-runtime-config`/`problem-management` spec 中的单容器残留描述
- [ ] 8.4 恢复根目录 `ROADMAP.md`（与 worktree 版本对齐，剔除已过时内容）；删除根目录 `hp-check.log`/`nvim.log` 工作区垃圾

## 9. UI 与文档

- [ ] 9.1 `noj-ui` admin 题目编辑器上传区改为统一包导入入口（`import-bundle`），更新文件结构引导文案（含"下载的支持包为剥离后评测包"说明）
- [ ] 9.2 更新 `openspec/specs/support-package-upload/spec.md`（上传 Requirement 移除）与 `openspec/specs/problem-runtime-config/spec.md`（同步 delta）；包格式规范成文（目录三层模型 + 导入载体结构 + CLI 用法）供 noj-docs 引用
- [ ] 9.3 更新 `noj-core/CLAUDE.md` 相关章节（题目导入路径、data 目录、CLI 用法）

## 10. 测试与 E2E

- [ ] 10.1 CLI 单元/集成测试：`noj.ts` 各子命令 help 输出、参数校验（`--email`/`--id`/`--dir`）、`problems import` 幂等、`dev-setup` 聚合顺序
- [ ] 10.2 补 storage 目录分离测试：local 模式 `storage.put()` 落盘到 `data/storage/` 而非 `data/packages/`
- [ ] 10.3 `noj-tests/e2e` 新增统一包导入闭环：admin 上传统一包 → 题目创建 → 提交评测 → 结果正常（评测包剥离后可用）
- [ ] 10.4 全量回归：`deno task test`（core）、`cargo test`（judge 无改动验证）、noj-tests E2E 通过
