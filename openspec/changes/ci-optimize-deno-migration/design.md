## Context

当前 CI 工作流 (`.github/workflows/ci.yml`) 有三个并行 Job：`core-test`、`ui-check`、`judge-check`。存在以下问题：

- **UI Job 仍用 Node.js** — noj-ui 已迁移到 Deno 运行时（`deno.json` 含 `build`/`lint`/`fmt` 任务），但 CI 仍用 `setup-node@v4` + `npm install` + `npm run build`
- **Core/UI/Judge Job 内步骤未拆分** — `core-test` 的 fmt/lint/test 都在一个 job 内，无法并行且日志混杂
- **Judge Job 存在冗余编译** — `cargo clippy`（含编译）+ `cargo build`（重复编译）+ `cargo test`（第三次编译）
- **文档过时** — README.md 仍列 Node.js 为前置依赖；CLAUDE.md 快速启动部分仍提 `npm install`

## Goals / Non-Goals

**Goals:**
- CI UI Job 使用 Deno 运行，移除 Node.js 依赖
- 拆分 Core 和 Judge 的步骤为独立 Job，利用 GHA 原生并行能力
- 消除 Judge Job 中的冗余 `cargo build` 步骤（clippy 已含编译）
- 更新 README.md、CLAUDE.md 和 E2E 注释，去除 Node.js 引用
- 保持 CI 正确性：任何一步失败都能准确反映

**Non-Goals:**
- 不引入 Docker 镜像缓存、sccache、tokio 特性裁剪等纯性能优化
- 不改变 npm `node_modules` 管理模式（`package.json` 仍保留作为 npm 依赖清单，通过 Deno BYONM 解析）
- 不修改测试逻辑或测试门控策略

## Decisions

### 1. Core Job 拆分方案

**当前**: 一个 `core-test` Job 内含 fmt → lint → test（带 PG+Redis 服务容器）

**改为**:
- `core-fmt` — `deno fmt --check`，轻量无服务依赖
- `core-lint` — `deno lint`，轻量无服务依赖
- `core-test` — `deno test -A --parallel`，需 PG+Redis 服务容器

**理由**: fmt 和 lint 无外部依赖，无需占用带服务容器的 runner。拆分后可并发执行，且失败时能明确标识是 fmt/lint/test 哪个环节出问题。

**注意**: `core-test` 保留 services (PG+Redis)，`core-fmt` 和 `core-lint` 不用 services 以节省资源。

### 2. UI Job 迁移到 Deno

**当前**: `setup-node@v4` → `npm install` → `npm run build`

**改为**: `setup-deno@v2` → `deno task build`

**理由**: noj-ui 的 `deno.json` 已定义 `build` 为 `deno task copy-monaco && deno run -A npm:nuxt build`。Deno 的 npm 兼容层（BYONM）会自动从 `node_modules/` 解析 CJS 包，无需单独安装 Node.js。

**`deno install` 步骤**: deno.json 设置了 `"nodeModulesDir": "auto"`，Deno 会自动处理 node_modules。但 CI 环境中需要显式 `deno install` 来确保依赖下载完成，否则 build 可能失败。

```
deno install → deno task build
```

### 3. Judge Job 拆分

**当前**: 一个 `judge-check` Job 内含 fmt → clippy → build → test

**改为**:
- `judge-fmt` — `cargo fmt --all --check`，轻量
- `judge-clippy` — `cargo clippy --all-targets -- -D warnings`（自带编译）
- `judge-test` — `cargo test`

**注意**: 去掉中间的 `cargo build` 步骤。clippy 已经触发了完整编译，`cargo test` 会复用 clippy 的编译产物。

**Cargo 缓存**: 三个 Judge Job 共享 Cargo 缓存。GitHub Actions 的 `actions/cache@v4` 在 job 间通过 GHA 的内置缓存层共享——修改 `key` 为使用 `Cargo.lock` hash 以确保缓存一致性即可。

### 4. 文档更新范围

| 文件 | 变更 |
|------|------|
| `README.md` | 移除 `Node.js >= 20` 环境要求；技术栈表 noj-ui 改为 `Deno / TypeScript`；前端启动步骤调整 |
| `CLAUDE.md` | 快速启动中移除 `npm install` 步骤；技术栈表确认 |
| `.github/workflows/e2e.yml` | 注释中技术栈描述从 "Deno + Node.js + Rust" 改为 "Deno + Rust" |

## Risks / Trade-offs

1. **[风险] 拆分 Job 后状态可见性与认知负担** →
   当前 3 个 Job → 拆分后 8 个 Job。日志更清晰，但 PR 状态面板更拥挤。可在 `ui-check` 等 Job 名添加图标前缀或分组名缓解。

2. **[风险] Cargo 缓存跨 Job 命中率** →
   GHA 的 `actions/cache@v4` 在同一个 workflow run 的不同 job 间通过 `ACTIONS_RUNTIME_TOKEN` 共享缓存。三个 Judge Job 使用相同的 cache key 访问同一缓存，命中率不受影响。

3. **[风险] `deno install` 增加额外网络开销** →
   首次运行时 `deno install` 需要下载 npm 依赖（~30-60s）。可通过 `actions/cache` 缓存 `noj-ui/node_modules` 缓解。

   权衡：整体构建仍比 `npm install` + `npm run build` 快（Deno 的 npm 解析层比 Node.js 的依赖解析更快），且不再需要同时维护 Node.js 和 Deno 两个运行时。

4. **[风险] fmt/lint 在单独的 Job 中可能因版本不同而结论不一致** →
   CI 使用固定的 Deno 版本 (`v2.x`)，与 core-test 保持一致，不存在版本不一致问题。
