# 参考手册与规范索引（Reference）

本章提供 Neuro OJ
全局通用的技术规范字典、评测终态定义、标准术语汇编与版本迭代历史，供开发者、出题人与运维专家随时查阅底层协议细节与数据字典。

---

## 参考索引矩阵

<div class="grid grid-cols-1 md:grid-cols-2 gap-4 my-6">

<div class="p-5 border border-gray-200 dark:border-gray-800 rounded-lg hover:border-blue-500 transition-all">

### 📖 [统一术语汇编（Glossary）](./glossary.md)

全站核心抽象与实体权威定义。对 Evaluator / Solution / Judge Worker /
运行时配置等易混淆术语进行精准边界辨析。

</div>

<div class="p-5 border border-gray-200 dark:border-gray-800 rounded-lg hover:border-blue-500 transition-all">

### 🎯 [提交结果状态与评分模型（Result Status）](./result-status.md)

系统终态（`finished` / `error`）与测试点用例状态（Accepted / WrongAnswer
等）的严格分层、两层超时处理与容错判分哲学。

</div>

<div class="p-5 border border-gray-200 dark:border-gray-800 rounded-lg hover:border-blue-500 transition-all">

### 🗃️ [数据库与 Redis 数据字典（Data Dictionary）](./data-dictionary.md)

PostgreSQL 全量核心业务表（users, problems, submissions, contests 等）及 Redis
键空间（MQ 队列、缓存、锁）物理字段级参考手册。

</div>

<div class="p-5 border border-gray-200 dark:border-gray-800 rounded-lg hover:border-blue-500 transition-all">

### 📜 [版本更新日志（Changelog）](./changelog.md)

记录 Neuro OJ
平台自早期原型、双容器沙箱重构、生产运维体系收敛至当前版本的重大里程碑与功能演进历史。

</div>

</div>
