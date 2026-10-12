# 系统架构与底层设计

本章面向希望深入理解 Neuro OJ
底层实现、高可用设计与安全基线的架构师、运维工程师与系统开发者，系统介绍微服务拓扑、存储交付、安全隔离与风控治理机制。

---

## 知识导航矩阵

<div class="grid grid-cols-1 md:grid-cols-2 gap-4 my-6">

<div class="p-5 border border-gray-200 dark:border-gray-800 rounded-lg hover:border-blue-500 transition-all">

### 🏛️ [系统整体架构（Architecture）](./architecture.md)

微服务拓扑解剖、各组件运行环境与职责划分、异步评测任务流向以及端到端生命周期追踪。

</div>

<div class="p-5 border border-gray-200 dark:border-gray-800 rounded-lg hover:border-blue-500 transition-all">

### 🛡️ [安全模型与基线（Security）](./security.md)

认证鉴权体系、JWT 会话吊销机制、Docker
最小权限沙箱配置、题目访问仲裁算法与提交结果动态脱敏投影。

</div>

<div class="p-5 border border-gray-200 dark:border-gray-800 rounded-lg hover:border-blue-500 transition-all">

### 📦 [存储与评测包交付体系（Storage）](./storage.md)

两层 URI
解耦哲学：持久化存储层（`noj-storage://`）与评测分发交付层（`noj-download://`），支持包生命周期。

</div>

<div class="p-5 border border-gray-200 dark:border-gray-800 rounded-lg hover:border-blue-500 transition-all">

### 🗄️ [对象存储生命周期治理（Governance）](./object-storage-governance.md)

对象类型梳理、数据库与 MinIO 引用对账、只读孤儿盘点基线与 Prometheus
容量监控预警。

</div>

<div class="p-5 border border-gray-200 dark:border-gray-800 rounded-lg hover:border-blue-500 transition-all">

### 🕵️ [竞赛风控与防作弊机制（Anti-Cheat）](./anti-cheat.md)

人工复核线索哲学、基于 Token 指纹与 Jaccard 相似度的代码查重引擎，以及来源 IP
机制下线的安全审计背景。

</div>

</div>

::: tip 生产部署与操作
本章专注于系统的底层原理、设计哲学与数据流。若需进行集群安装、启停配置、备份恢复或版本升级等**实际运维操作**，请直接查阅 [运营者运维指南](../operators/index.md)。
:::
