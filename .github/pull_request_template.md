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
- [ ] 数据库迁移（新建或修改 `drizzle/` 文件）
- [ ] 公共 API（端点 / 请求 / 响应结构变化）
- [ ] 配置 / 环境变量（`.env.example` 已更新）
- [ ] OpenSpec 规范（specs/ 或 changes/ 改动）
- [ ] 文档（README / noj-docs）

## 验证清单

<!-- 提交前自查，确保所有项打勾。CI 会强制跑一遍，但本地先过能省一轮 CI 时间。 -->

- [ ] `deno fmt` 已运行（noj-core / noj-ui）
- [ ] `deno lint` 已运行
- [ ] `cargo fmt && cargo clippy` 已运行（noj-judge）
- [ ] 本地 `deno task test` 通过
- [ ] 新功能 / 修复有对应测试
- [ ] 数据库 schema 变更已通过 `deno task db:generate` 生成迁移
- [ ] 提交信息符合 Conventional Commits（`<type>(<scope>): 中文描述`）
- [ ] 若是功能变更，已 `/opsx:propose` 起草 OpenSpec 提案
- [ ] 非平凡变更包含 Agent Note（`.agents/notes/implemented/`）
- [ ] 相关文档已同步（AGENTS / CLAUDE / docs / noj-docs）
- [ ] 注释/导出 JSDoc 与实现一致（`deno task check:jsdoc` 通过）
- [ ] 新增/修改行为有对应测试
- [ ] GPG 签名可用

## 截图 / 录屏（可选）

<!-- UI 变更强烈建议附上。拖入图片或贴 GIF 链接均可。 -->

## 补充说明（可选）

<!-- reviewer 关注点、风险、回滚方案、相关 PR 链接等。 -->
