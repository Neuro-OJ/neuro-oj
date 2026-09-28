# Agent Note: noj-docs 导航架构修复与信息组织重构

Status: implemented

## Problem

原 `noj-docs` 存在严重的易读性、导航与架构问题：

1. 顶部 Nav 仅保留 3 个外链，站内导航完全缺失；自定义的 `SectionTabs.vue` 在宽度小于 1280px 时直接隐藏，且 `Layout.vue` 遗留了未完成的 AstrBot 硬编码路由判定，导致侧边栏样式隔离失效。
2. 侧边栏粗暴采用单一根路径大杂烩，并在“面向角色”与“面向主题”两层折叠下塞入全站数十篇文档，用户认知负担极重、迷航感强烈。
3. 历史迁移留下了 11 个仅有一句话“本文档已迁移至 xxx”的空桩页面（Stub pages），割裂感明显。
4. 首页过于单薄，缺少面向选手、出题人和运维部署者的分流导引与核心链路可视化。
5. 原有页面排版风格不统一，部分机制与系统文档缺乏图解、表格与时序流转，技术概念阐述密集但不易读。

## Decision

1. **废弃技术债与缺陷组件**：
   - 移除 `SectionTabs.vue` 与未完成的 `Layout.vue`，直接继承 VitePress 官方标准的 `DefaultTheme.Layout`；
   - 清理 `style.css` 中基于 `nth-of-type` 隐藏 group 的 hack 样式与残余媒体查询，恢复 VitePress 原生响应式体验。
2. **重构顶部导航与多侧边栏（Multi-Sidebar）**：
   - 顶部 Nav 建立 5 大知识域一级入口：`做题指南` (/users/)、`出题指南` (/problemsetters/)、`运维部署` (/operators/)、`评测机制与架构` (/mechanisms/)、`参考手册` (/reference/)；
   - 针对各业务域建立独立的专用侧边栏，实现角色闭环与渐进式信息披露。
3. **彻底清理历史占位空桩**：
   - 物理删除 11 个仅有跳转占位符的历史兼容文档（`problemsetters/` 下的 8 个、`users/` 下的 2 个、`operators/` 下的 1 个）；
   - 全面修复 `llm-problem.md`、`quick-start.md`、`web-editor.md`、`ab-example.md` 中指向旧桩文件的相对链接，统一指向 mechanisms / standards 目录的权威真实页面。
4. **全站页面结构化重构与现代排版（全量 6 大批次）**：
   - **首页与概览**：首页增加“三大角色直通向导”卡片与核心评测链路 Mermaid 图；
   - **做题人指南 (`intro/`, `users/`)**：提炼 Python 顶层函数约定、产物提交规范、受限网络原理解析、LMCC 插件配置与账户安全生命周期；
   - **出题人指南与规范 (`problemsetters/`, `standards/`)**：构建 5 步极速出题法、A+B 样例工程解剖、预检 Preflight 阻断规则、题目包 ZIP 安全解压红线与双类标签规范；
   - **平台功能 (`features/`)**：重构 Kaggle 赛制计分与状态机、全域题目收编 404 保密门控、题单完成度计算、客观题即时判定与防作弊盲测、四级 Tiebreaker 天梯排行、社区双轨内容风控与站内私信；
   - **评测机制与架构 (`mechanisms/`, `system/`)**：详述双容器分工与三通道隔离、NDJSON 帧格式与类型白名单、两层超时映射、微服务拓扑时序、两层 URI 交付（`noj-storage://` 与 `noj-download://`）及对象存储只读盘点；
   - **参考手册 (`reference/`)**：明确提交终态（`finished` / `error`）与测试点状态解耦、更新全量索引。

## Alternatives considered

- 继续维护 `SectionTabs.vue` 并补齐移动端适配：这与 VitePress 标准的顶栏设计背道而驰，增加维护负担，且破坏了移动端内置抽屉导航的一致性。
- 保留 11 个桩页面并注入前端自动跳转：虽然对极少数旧书签兼容，但长期保留会导致目录混乱、同目录相对路径引用腐蚀，且容易误导维护者。彻底物理移除更彻底、更易维护。

## Consequences

- 移动端、平板、分屏与桌面端均享有 VitePress 官方标准的响应式导航体验。
- 彻底消除了无实际内容的占位空壳页面，出题、做题与运维目录更加纯粹清爽。
- 业务语义 100% 严谨保留，配合 Mermaid 图解、参数表格与 Callout 提示框，阅读体验与专业性显著提升。
- 全站 Markdown 链接检查全绿（506 个文件全部通过 `verify-md-links.ts`），VitePress 生产构建 0 错误 0 告警通过。
