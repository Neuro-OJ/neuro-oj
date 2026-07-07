## 1. CI: UI Job 迁移到 Deno

- [ ] 1.1 在 `ci.yml` 中创建新的 `ui-check` Job：替换 Node.js 安装为 `denoland/setup-deno@v2`
- [ ] 1.2 添加 `deno install` 步骤安装 npm 依赖（兼容 BYONM 模式）
- [ ] 1.3 添加 `deno task build` 步骤替换 `npm run build`
- [ ] 1.4 添加 `noj-ui/node_modules` 缓存步骤（`actions/cache@v4`，key 基于 `noj-ui/package.json`）

## 2. CI: Core Job 拆分为独立 Job

- [ ] 2.1 创建 `core-fmt` Job：`deno fmt --check`（轻量，无服务依赖）
- [ ] 2.2 创建 `core-lint` Job：`deno lint`（轻量，无服务依赖）
- [ ] 2.3 保留 `core-test` Job：`deno test -A --parallel`（保留 PG+Redis 服务容器）
- [ ] 2.4 删除旧的 `core-test` Job 中的 fmt 和 lint 步骤

## 3. CI: Judge Job 拆分为独立 Job

- [ ] 3.1 创建 `judge-fmt` Job：`cargo fmt --all --check`
- [ ] 3.2 创建 `judge-clippy` Job：`cargo clippy --all-targets -- -D warnings`（去除 `cargo build`）
- [ ] 3.3 创建 `judge-test` Job：`cargo test`（复用 clippy 编译产物）
- [ ] 3.4 为三个 Judge Job 配置 Cargo 缓存（共享 key）
- [ ] 3.5 删除旧的 `judge-check` Job

## 4. 文档更新

- [ ] 4.1 更新 `README.md`：移除 `Node.js >= 20` 环境要求；技术栈表 noj-ui 运行时改为 `Deno / TypeScript`
- [ ] 4.2 更新 `README.md`：前端启动步骤改为 `deno install && deno task dev`
- [ ] 4.3 更新 `CLAUDE.md`：快速启动章节移除 `npm install` 步骤，确认 noj-ui 技术栈
- [ ] 4.4 更新 `.github/workflows/e2e.yml`：注释技术栈从 "Deno + Node.js + Rust" 改为 "Deno + Rust"

## 5. 验证

- [ ] 5.1 运行 `deno task build` 在 noj-ui 中验证构建通过
- [ ] 5.2 推送分支并确认 CI 所有拆分后的 Job 均通过
- [ ] 5.3 故意引入 fmt 格式问题，验证 `core-fmt` Job 准确失败且其他 Job 不受影响
- [ ] 5.4 故意引入 lint 错误，验证 `core-lint` Job 准确失败且 `core-test` 不受影响
