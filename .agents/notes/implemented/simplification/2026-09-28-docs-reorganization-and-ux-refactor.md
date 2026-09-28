# Agent Note: noj-docs 导航架构修复与信息组织重构

Status: implemented

## Problem

原 `noj-docs` 存在严重的易读性、导航与架构问题：

1. 顶部 Nav 仅保留 3 个外链，站内导航完全缺失；自定义的 `SectionTabs.vue`
   在宽度小于 1280px 时直接隐藏，且 `Layout.vue` 遗留了未完成的 AstrBot
   硬编码路由判定，导致侧边栏样式隔离失效。
2. 侧边栏粗暴采用单一根路径大杂烩，并在“面向角色”与“面向主题”两层折叠下塞入全站数十篇文档，用户认知负担极重、迷航感强烈。
3. 历史迁移留下了 11 个仅有一句话“本文档已迁移至 xxx”的空桩页面（Stub
   pages），割裂感明显。
4. 首页过于单薄，缺少面向选手、出题人和运维部署者的分流导引与核心链路可视化。

## Decision

1. **废弃技术债与缺陷组件**：
   - 移除 `SectionTabs.vue` 与未完成的 `Layout.vue`，直接继承 VitePress
     官方标准的 `DefaultTheme.Layout`；
   - 清理 `style.css` 中基于 `nth-of-type` 隐藏 group 的 hack
     样式与残余媒体查询，恢复 VitePress 原生响应式体验。
2. **重构顶部导航与多侧边栏（Multi-Sidebar）**：
   - 顶部 Nav 建立 5 大知识域一级入口：`做题指南` (/users/)、`出题指南`
     (/problemsetters/)、`运维部署` (/operators/)、`评测机制与架构`
     (/mechanisms/)、`参考手册` (/reference/)；
   - 针对各业务域建立独立的专用侧边栏，实现角色闭环与渐进式信息披露。
3. **彻底清理历史占位空桩**：
   - 彻底删除 11 个仅有跳转占位符的历史兼容文档（`problemsetters/` 下的 8
     个、`users/` 下的 2 个、`operators/` 下的 1 个）；
   - 全面修复
     `llm-problem.md`、`quick-start.md`、`web-editor.md`、`ab-example.md`
     中指向旧桩文件的相对链接，统一指向 mechanisms / standards
     目录的权威真实页面。
4. **提升首页与导读体验**：
   - 首页增加“三大角色直通向导”卡片与核心评测链路 Mermaid
     图，帮助新访客快速找到第一步。

## Alternatives considered

- 继续维护 `SectionTabs.vue` 并补齐移动端适配：这与 VitePress
  标准的顶栏设计背道而驰，增加维护负担，且破坏了移动端内置抽屉导航的一致性。
- 保留 11
  个桩页面并注入前端自动跳转：虽然对极少数旧书签兼容，但长期保留会导致目录混乱、同目录相对路径引用腐蚀，且容易误导维护者。彻底物理移除更彻底、更易维护。

## Consequences

- 移动端、平板、分屏与桌面端均享有 VitePress 官方标准的响应式导航体验。
- 彻底消除了无实际内容的占位空壳页面，出题、做题与运维目录更加纯粹清爽。
- 全站 Markdown 链接检查全绿（506 个文件），VitePress 生产构建 0 错误 0
  告警通过。
