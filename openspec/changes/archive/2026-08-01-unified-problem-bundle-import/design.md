# Unified Problem Bundle Import — Design

## Context

题目导入现状存在四条互不兼容的路径：

| 路径 | 载体 | 问题 |
|------|------|------|
| `scripts/seed.ts` | 代码硬编码 `SAMPLE_PROBLEMS`（题面 + `runtime_config`） | 题面写在 TS 字符串里，改题面要改代码；与 `problems-src/` 内文件双份维护 |
| `scripts/build-packages.ts` | `data/problems-src/<id>/` → `data/packages/<id>.zip` | 排除规则只写 `submission.py`，漏掉 `submission_sample.py`/`__pycache__`，实测参考实现与 pyc 垃圾进入评测包 |
| `POST /problems/:id/support-package` | 松散 zip（仅评测内容） | 无 manifest、无结构校验，只更新 `support_package_storage_url` |
| `problems-export/import` | JSON 元数据 | 不含支持包文件与 testcase，round-trip 不完整 |

另有三层目录关系混乱：`data/packages/` 同时是构建产物输出目录与 `LocalStorageProvider`（`PACKAGES_DIR = "data/packages"` 硬编码）的存储后端，90+ 个测试残留 zip 与真实评测包混杂；`data/problems/` 是零引用的空壳目录。

约束：`noj-judge` 将支持包解压到容器 `/workspace`，评测命令为 `python3 /workspace/evaluate.py`——**judge 对包内容透明，本次零改动**；`support_package_storage_url` 的既有语义是"judge 下载的评测包"；`problems.id` 主键为文本（服务端 UUID 或 seed 的 `"1001"` 式 id），`number` 在 type 内自增。

## Goals / Non-Goals

**Goals:**
- 单一"题目包"格式（导入载体 zip）承载题面、评测内容、评测配置，一键导入创建/更新题目
- 单一导入服务：admin 上传与 seed 共用同一解析-校验-落库路径
- 题面/元数据唯一事实来源是数据库：存储的评测包剥离 `problem.json`/`statement.md`，消除"包内旧题面"误导与 upsert 覆盖冲突
- data 目录按生命周期分层：源目录 → 构建产物 → storage 后端，互不混用
- 打包规则标准化：参考实现与垃圾文件永不进入评测包

**Non-Goals:**
- testcase 格式标准化（保留给题目自定，`evaluate.py` 自行读取）
- 评测详情 in/out 隐藏（维持 `evaluate.py` 自行决定）
- 引入 tags（系统仅 `categories`；manifest 预留扩展位）
- noj-judge 任何改动
- 旧式无 manifest zip 的兼容（严格拒绝）

## Decisions

### D1：统一包格式（导入载体）

zip 根级布局，`evaluate.py` **强制根级**：

```
problem.zip
├── problem.json   # manifest，必填
├── statement.md   # 题面 Markdown，必填
├── evaluate.py    # 评测脚本，强制根级（judge 命令路径确定性 → judge 零改动）
├── visible.jsonl  # testcase——不标准化
└── assets/        # 任意其他资源
```

manifest 字段（与现有 API/表字段对齐）：

| 字段 | 必填 | 说明 |
|------|:---:|------|
| `format_version` | ✅ | 当前 `1`，预留演进 |
| `title` | ✅ | |
| `statement.md` 文件 | ✅ | 与 `manifest.description` 二选一（`description` 保留兼容，缺省以文件为准） |
| `evaluate.py` 文件 | ✅ | 根级缺失 → 400 |
| `runtime_config` | ✅ | 复用 `validateRuntimeConfig` + 镜像白名单；`evaluator.command` 缺省注入 `python3 /workspace/evaluate.py` |
| `number` | ❌ | 仅 admin 生效：幂等键——(type, number) 匹配既有题目则更新；缺省 type 内 MAX+1 |
| `difficulty` | ❌ | 缺省 `medium` |
| `type` | ❌ | 缺省 `U`（P 型仅 admin） |
| `categories` | ❌ | 按 name 匹配已有分类，缺省忽略 + warning（复用 `problems-export` 语义） |
| `samples` | ❌ | 预留字段（仅校验格式，不落库）；样例由展示层从题面提取 |

替代方案（否决）：manifest 内嵌 `description`（长题面 JSON 转义不友好）；testcase 标准化 in/out 文件对（用户明确否决，保持题目自定）。

### D2：剥离后存储

上传 zip = 导入载体；导入时 core 用 `fflate.unzipSync(data, {filter})` 跳过 `problem.json`/`statement.md` 两个固定名条目，`fflate.zipSync` 重建"纯净评测包"后 `storage.put()`。剥离规则=按固定文件名剔除，其余条目（testcase/assets）原样保留。

替代方案（否决）：1:1 原样存储——WebUI 编辑题面后包内 `statement.md` 是旧快照，重新上传（upsert）会把 DB 新题面覆盖回旧版，存在数据回退风险；双存储——冗余。

### D3：严格新格式 + 端点收敛

- 无 manifest 的 zip 一律 400（**BREAKING**）
- 新增 `POST /api/v1/problems/import-bundle`（multipart `file` 字段；admin 任意 type 可指定 `number` 作为幂等键；owner 仅 U 型且 `number` 被忽略——延续"id 由服务端生成"的安全约定）为**唯一上传入口**：admin 提供 `number` 且 (type, number) 匹配既有题目 → 更新元数据 + 替换评测包；未命中或未提供 → 创建（id 一律服务端生成 UUID，(type, number) 由 DB 联合唯一约束保证唯一）
- **废弃** `POST /:id/support-package` 上传端点（GET 下载 / DELETE 删除保留）——严格化后它只是 `import-bundle` 的受限形态（manifest 必填 + 路径 id 必须与题目匹配 + 题目必须存在），保留即冗余路径；前端改用 `import-bundle`
- 权限：导入创建 U 型=登录用户（owner），P 型=admin；审计日志沿用现有中间件；上传上限 128 MiB 沿用

### D4：目录三层模型

`data/problems-src/<id>/`（源目录，versioned）→ `data/packages/<id>.zip`（构建产物 = 导入载体，gitignored）→ `data/storage/<hash>.zip`（StorageProvider 后端，gitignored，新默认目录）。`local.ts` 的 `PACKAGES_DIR` 从 `data/packages` 改为 `data/storage`（保留 `SUPPORT_PACKAGE_DIR` 环境变量覆盖）；`noj-storage://local/<base64>` URL 格式与 S3 路径前缀不变。删除 `data/problems/` 空壳；清空 `data/packages/` 测试残留。

```
data/problems-src/<id>/    源目录（versioned）：problem.json + statement.md + evaluate.py + testcase + 参考实现
        │ build-packages.ts（排除 submission* / __pycache__ / .git）
        ▼
data/packages/<id>.zip     构建产物 = 导入载体（gitignored）
        │ seed 或 admin 上传 → 统一导入服务（剥离）
        ▼
data/storage/<hash>.zip    LocalStorageProvider 存储后端（gitignored，新默认目录）
```

### D5：CLI 工具集（Cliffy 单入口）

废弃 `seed.ts`/`build-packages.ts` 脚本与 `seed`/`build-packages`/`setup` task 名（`seed` 语义模糊且职责混杂），改为 Cliffy 单入口 `scripts/noj.ts`：

- `db migrate`——数据库迁移（对齐 `db:generate` 命名风格）
- `init system`——系统基础数据：root 用户 + RBAC 预置 + 镜像白名单 + 分类（生产必需，幂等）
- `bootstrap admin`——管理员引导（`ensureAdminFromEnv` + `ensureBootstrapAdmin`，支持 `--email`/`--password` 传参）
- `problems build`——`problems-src` → 统一题目包构建（排除 `submission*`/`__pycache__`/`.git`，`--id` 可选）
- `problems import`——扫描目录（默认 `data/packages/`）调 `importProblemBundle` 幂等导入（依赖 D4 目录分离，避免误扫 storage 对象）
- `dev-setup`——开发环境聚合：以上全部 + dev 专用数据（示例题 1001-1003、E2E 守卫用户），生产初始化不执行此命令

`deno.json` tasks 同步重命名（`db:migrate`/`init:system`/`bootstrap:admin`/`problems:build`/`problems:import`/`dev-setup`）；删除 `scripts/db/*.sh`、`scripts/build/*.sh` 重复封装层；`admin-authorization`/`rbac-core` 主 spec 与文档中的 `deno task seed` 引用全部更新。

技术选型：Cliffy（`@cliffy/command`）提供自动 help、类型化选项校验、子命令嵌套与 shell 补全，Deno 原生（jsr 分发）；替代方案（否决）：`npm:commander`（非 Deno 原生）、`@std/cli` 手写（缺 help/子命令能力）、Rust 组件（与 core 的 Drizzle schema/storage/校验双份实现，维护成本不成比例）。

### D6：依赖选择

引入 npm `fflate`（唯一新依赖）：无传递依赖、`unzipSync` 支持 `filter` 跳过条目、`zipSync` 重建打包、纯 JS 内存操作。替代方案（否决）：系统 `unzip` 命令（shell 依赖 + 临时目录落盘）、`jszip`（功能全但依赖重）。

### D7：废弃 JSON 元数据导入导出

移除 `problems-export/import`（issue #28）整条链路：`services/problems-export.ts`（`buildExportPayload`/`importProblems`）、`types/problems.ts` 中 `ExportPayload`/`ExportProblem`/`ExportQuery`/`ImportStrategy`/`ImportItemResult`/`ImportReport`/`EXPORT_VERSION`、`problems.ts` 的 re-export、`tests/services/problems-export.test.ts`。

理由：实测 `buildExportPayload`/`importProblems` 在 routes/ 与 app.ts **零引用**（服务层死代码）；统一包上线后完整题目（含评测内容）的备份/迁移由统一包承担，JSON 元数据导入的批量能力被"build-packages 批量构建 + seed 批量导入"覆盖。`isValidProblemType` 等被 `createProblem` 复用的校验函数保留。

## Risks / Trade-offs

- [fflate 重建 zip 的压缩级别与原包不同 → 字节/checksum 变化] → 无影响：checksum 由 `storage.put()` 存储时计算，评测校验链路不受影响；重建后体积差异不显著
- [剥离后"下载支持包 ≠ 上传文件"（差两个元数据文件）] → 语义上说得通（下载的是评测包），UI 引导文案与文档明确注明
- [seed 误扫 storage 目录导致重复/错误导入] → D4 目录分离后 `data/packages/` 只含构建产物，且导入幂等（admin 按 (type, number) upsert）
- [解压 + 重建的内存峰值（512 MiB 上限）] → 导入是低频管理操作，128 MiB 上传上限下内存可接受
- [现有存量题目（1001-1003）的支持包无 manifest] → seed 重构后由 `problems-src` 重新构建导入，一次迁移完成；存量数据库行由 seed 幂等更新
- [BREAKING：旧客户端直接上传松散 zip 被拒] → 预期行为（严格新格式），文档与 UI 引导先行更新

## Migration Plan

1. 实施 D1-D3（core 侧）：新增 `import-bundle` 端点与统一导入服务，同时保留旧 `POST /:id/support-package`（暂不删除）——先并行验证
2. 实施 D4-D5（目录整治 + seed 重构），重跑 `deno task build-packages && deno task seed` 完成存量题目迁移
3. 验证通过后移除 `POST /:id/support-package` 上传端点与 JSON import/export 链路（D3/D7），前端切换 `import-bundle`
4. 回滚：若导入服务异常，旧支持包存储仍完好（`support_package_storage_url` 不变），恢复 seed 旧逻辑即可

## Open Questions

无（格式、存储关系、清理范围均已在规划阶段确认）。
