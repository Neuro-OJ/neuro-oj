# 系统架构与运维主题

> 本部分面向想了解 Neuro OJ 内部实现的运营者与开发者，介绍系统架构、安全模型、存储交付与风控数据边界。

建议按以下顺序阅读：

1. [系统架构](architecture.md) — 模块组成、基础设施与评测交付链路。
2. [安全模型](security.md) — 认证、密码、沙箱隔离、题目可见性与结果投影。
3. [存储与评测包交付](storage.md) — `noj-storage://` 与 `noj-download://` 两层 URL。
4. [对象存储生命周期治理](object-storage-governance.md) — 只读盘点、对象类型与告警。
5. [竞赛风控数据说明](anti-cheat.md) — 来源 IP 与代码相似度线索的用途与保留策略。

::: tip 运维操作请走 CLI
本部分讲"系统如何设计"；安装、启停、升级、备份等**实际运维动作**请使用 `noj-cli`，参见[运营者文档](../operators/index.md)。
:::
