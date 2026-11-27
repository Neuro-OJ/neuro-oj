<!--
感谢提交 PR！填写以下内容可帮助 reviewer 更快理解你的改动。
本模板与 CI 无关（不会阻断合并），但 Closes #XXX 行会让 GitHub 自动关闭对应 issue。
-->

## 关联 Issue

<!--
在下方写 Closes #123 / Fixes #456 / Resolves #789（必须是关键字 + 数字格式）。
GitHub 检测到后会在 PR merge 时自动关闭对应 issue。
注意：必须是关键字 + 英文井号，例如 `Closes #186`（不是 `关闭 #186` 也不是 `Closes issue #186`）。
issue 未提供 / 不适用 → 写 "无"。
-->

Closes #

## 变更摘要

<!-- 1-3 句话说清做了什么、为什么。 -->

-

## 变更类型

<!-- 勾选所有适用的项 -->

- [ ] `feat` 新功能
- [ ] `fix` Bug 修复
- [ ] `refactor` 重构（无行为变化）
- [ ] `perf` 性能优化
- [ ] `docs` 文档
- [ ] `test` 测试
- [ ] `chore` 杂项 / 构建 / CI
- [ ] `break` 不兼容变更（需要 major 版本号或迁移说明）

## 影响范围

<!-- 勾选所有受影响的模块 / 数据 / 行为 -->

- [ ] `noj-core` 后端
- [ ] `noj-ui` 前端
- [ ] `noj-judge` 评测 Worker
- [ ] `noj-llm-gateway` LLM 代理
- [ ] `noj-cli` 生产运维 CLI
- [ ] `noj-tests` 跨模块 E2E 测试
- [ ] 数据库迁移（新建或修改 `drizzle/` 文件）
- [ ] 公共 API（端点 / 请求 / 响应结构变化）
- [ ] 配置 / 环境变量（`.env.example` 已更新）
- [ ] 文档（`README` / `AGENTS.md` / `dev-docs` / `noj-docs`）

## 验证清单

<!-- 提交前自查，确保适用项打勾；不适用项保持未勾选。 -->

- [ ] 已在对应模块目录运行 `deno fmt --check` 与 `deno lint`（不在仓库根目录直接跑全仓 `deno fmt`）
- [ ] `cargo fmt && cargo clippy` 已运行（`noj-judge`）
- [ ] 本地测试已通过（按对应模块 `deno task` / `cargo nextest` 运行）
- [ ] 新功能 / 修复有对应测试
- [ ] 数据库 schema 变更已通过 `deno task db:generate` 生成迁移
- [ ] 提交信息符合 Conventional Commits（`<type>(<scope>): 中文描述`）
- [ ] 非平凡变更包含 Agent Note（`.agents/notes/implemented/`）
- [ ] 相关文档已同步（`AGENTS.md` / `dev-docs` / `noj-docs`）
- [ ] 注释与实现一致
- [ ] GPG 签名可用

## 截图 / 录屏（可选）

<!-- UI 变更强烈建议附上。拖入图片或贴 GIF 链接均可。 -->

## 补充说明（可选）

<!-- reviewer 关注点、风险、回滚方案、相关 PR 链接等。 -->
