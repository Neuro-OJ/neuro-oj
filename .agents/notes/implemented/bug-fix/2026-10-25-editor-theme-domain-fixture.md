# Agent Note: 编辑器主题验收对齐 Domain 作答入口

Status: implemented

## Problem

编辑器主题浏览器测试仍使用旧的 `/editor/P22` 路由和
`/api/v1/problems/P22` 题目夹具。当前生产作答入口已经由 Domain workspace
负责，旧路由会重定向到 `/d/main/solve/22`，但测试没有提供 Domain workspace
和 Domain problem detail 响应，因此 Nuxt CI 在不启动 Core 的隔离浏览器 job
中收到 500，无法进入 Markdown 主题断言。

修正入口后，390px 场景还暴露了另一处测试与产品交互不一致：Domain 编辑器在
窄屏默认收起题面侧栏，测试直接要求隐藏的代码块可见，不能证明移动端的真实
主题行为。

## Decision

- 将 fixture 改为真实的 `/api/v1/domains/main` 与
  `/api/v1/domains/main/problems/22` 响应，保留完整 Markdown 描述、版本和
  `display_ref`，并从 `/d/main/solve/22` 进入页面。
- 在窄屏测试中通过工具栏“切换侧栏”按钮打开题面，再检查 `.prose-neuro` 的
  明暗背景、文字对比度、代码块、公式和无水平溢出；桌面场景保持默认展开。
- 不修改生产路由、响应合同或移动端默认布局；测试仍只使用本地 fixture，Core、
  PostgreSQL 和 Redis 不进入该浏览器 job。

## Alternatives considered

- 继续为旧 `/editor/P22` 路由补 fixture：会把已迁移的 legacy 入口当成主验收
  合同，无法覆盖 Domain 机制。
- 在生产组件中强制移动端默认展开侧栏：改变移动端编辑器的既有操作模型，且
  主题验收不需要改变产品行为。
- 对 390px 的可见性断言放宽为只检查 DOM：会漏掉用户真正打开题面后的主题和
  溢出问题，因此采用真实按钮交互。

## Consequences

主题验收现在覆盖真实 Domain 作答路由、Domain API envelope 和移动端侧栏交互。
本地生产构建后 Chromium 1440px、390px 两个场景均通过（2 passed / 0 failed）。
CI 仍需在新提交上重跑 Nuxt 与 E2E browser jobs；真实 Core/生产数据和真实浏览器
矩阵不由该 fixture 测试代替。
