# 功能特性概览

Neuro OJ 围绕 AI
领域评测与实战训练，构建了涵盖竞赛、题单、客观题套卷、社区交流与消息通知的全功能矩阵。

本章系统梳理各大功能模块的业务逻辑、权限控制与技术保障机制。

---

## 功能模块矩阵

<div class="grid grid-cols-1 md:grid-cols-2 gap-4 my-6">

<div class="p-5 border border-gray-200 dark:border-gray-800 rounded-lg hover:border-blue-500 transition-all">

### 🏆 [竞赛系统（Contests）](./contests.md)

专为 AI 竞赛设计的**类 Kaggle 分数赛**模式。支持队伍/个人提交、服务端封榜、SSE
实时排名推送、防作弊题目收编隔离以及赛后成绩快照结算。

</div>

<div class="p-5 border border-gray-200 dark:border-gray-800 rounded-lg hover:border-blue-500 transition-all">

### 📚 [题单系统（Trainings）](./trainings.md)

专题集训与备考刷题路线组织。支持私有/不公开/全站公开三级可见性，多题目排序与全局进度（通过率）动态汇总统计。

</div>

<div class="p-5 border border-gray-200 dark:border-gray-800 rounded-lg hover:border-blue-500 transition-all">

### 📝 [客观题套卷（Objective Tests）](./objective.md)

服务于理论知识测试（如 IOAI / LMCC
笔试）。内置单选、多选与判断题型，支持服务端亚毫秒级即时判定、JSON
批量出题导入与竞赛防预言机试探。

</div>

<div class="p-5 border border-gray-200 dark:border-gray-800 rounded-lg hover:border-blue-500 transition-all">

### 📊 [天梯排行榜与每日签到](./ranking.md)

公开天梯排行。采用四级 Tiebreaker 精确排序口径，基于 PostgreSQL
物化视图与节流写回支撑高并发查询；UTC 每日打卡与 365 天活跃日历。

</div>

<div class="p-5 border border-gray-200 dark:border-gray-800 rounded-lg hover:border-blue-500 transition-all">

### 💬 [社区与互动（Community）](./community.md)

题解、讨论与日常技术动态。集成合规内容风控审核、细粒度板块权限、点赞收藏关注与赛事期间的自动化题解全域保密门控。

</div>

<div class="p-5 border border-gray-200 dark:border-gray-800 rounded-lg hover:border-blue-500 transition-all">

### 🔍 [全局搜索与站内私信](./search-messages.md)

毫秒级多类型分面搜索与 `Ctrl + K` 命令面板，独立安全限流；端到端站内 1-on-1
私信、单向软删除历史与 SSE 实时同步。

</div>

<div class="p-5 border border-gray-200 dark:border-gray-800 rounded-lg hover:border-blue-500 transition-all">

### 📢 [系统公告与横幅（Announcements）](./announcements.md)

支持 Markdown 排版的平台公告发布系统，具备导航栏置顶横幅通知、变更 SSE
实时广播，与首页轮播海报完全解耦。

</div>

</div>

---

## 角色权限与功能对应关系

| 功能域     | 普通用户                               | 出题人                         | 比赛主办 / 管理员                             |
| ---------- | -------------------------------------- | ------------------------------ | --------------------------------------------- |
| **竞赛**   | 浏览报名公开赛 / 输入邀请码 / 提交做题 | 关联自己创建的题目             | 创建竞赛 / 导入题目 / 封榜管理 / 发布成绩快照 |
| **题单**   | 创建私有或链接分享题单 / 查看公开题单  | 将公开题与个人题建单           | 审核发布公开题单 (`training:publish`) / 置顶  |
| **客观题** | 在线作答 / 查阅对错与解析              | 组卷 / 批量导入试题 / 设定标答 | 题库全量管理与调度                            |
| **社区**   | 发帖 / 评论 / 提交通过题解             | 发布官方题解 / 参与答疑        | 板块配置 / 内容审核 / 封禁违规用户            |
| **搜索**   | 搜索题目、帖子、公告、竞赛             | 题目检索                       | **允许搜索用户数据** / 审计记录检索           |
| **公告**   | 查阅公告与横幅提醒                     | 查阅公告                       | 发布、置顶与下架公告 (`announcement:manage`)  |
