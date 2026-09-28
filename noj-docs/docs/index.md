---
layout: home

hero:
  name: "Neuro OJ"
  text: "面向 AI 领域认证与竞赛的在线评测平台"
  tagline: 函数调用型评测 · 双容器隔离沙箱 · LLM 智能体评测 · 竞赛与社区
  actions:
    - theme: brand
      text: 什么是 Neuro OJ
      link: /intro/what-is-noj
    - theme: alt
      text: 做题快速开始
      link: /users/quick-start
    - theme: alt
      text: 5 分钟快速出一题
      link: /problemsetters/quick-start

features:
  - icon: 🧩
    title: 函数调用型评测
    details: 突破传统 stdin/stdout 限制，由 Evaluator 主动调用用户模块声明的函数并评分，原生契合大模型与智能体能力评测。
  - icon: 🛡️
    title: 双容器隔离沙箱
    details: 用户代码（Solution）与评测代码（Evaluator）运行在物理隔离的 Docker 容器中，基于 RPC 通信，彻底防御 monkeypatch 篡改。
  - icon: 🌐
    title: 受限网络 Capability
    details: Solution 容器终身无网，通过出题人注册的白名单 Capability 间接、安全地调用外部网络与大模型 API。
  - icon: 🏆
    title: 全功能竞技与社区
    details: 实时排行榜、每日签到打卡、类 Kaggle 分数赛、套卷客观题、题单训练与站内动态私信，一站式闭环。
---

<div class="role-guide-section" style="margin-top: 48px; margin-bottom: 32px;">

## 🧭 快速找到你的专属指南

根据你的目标，选择最适合的阅读路径：

::: tip 👨‍💻 我是做题 / 参赛选手
- **第一步**：阅读 [做题快速开始](/users/quick-start) 注册账号并跑通第一道题。
- **掌握题型**：了解 [提交代码与语言约定](/users/submit) 以及 [使用 Capability 联网](/users/capability)。
- **工具加持**：在本地使用 [LMCC IDE / VS Code 插件](/users/lmcc-extension) 选题与一键提交。
- **参与竞技**：查看 [竞赛模式](/features/contests)、[题单训练](/features/trainings) 与 [排行榜](/features/ranking)。

👉 **[前往做题人文档中心 →](/users/)**
:::

::: tip ✍️ 我是出题人 / 裁判教练
- **极速上手**：跟随 [5 步端到端路径](/problemsetters/quick-start)，5 分钟写出第一个 `evaluate.py` 评测脚本。
- **掌握工具**：学习使用 [Web 题目编辑器全流程](/problemsetters/web-editor) 与参考 [A+B 完整样例题](/problemsetters/ab-example)。
- **高级题型**：制作 [LLM 智能体调用题](/problemsetters/llm-problem) 与 [客观题套卷出题](/problemsetters/objective-problem)。
- **规范与 SDK**：查阅 [题目包格式规范](/standards/problem-bundle) 与 [Evaluator SDK 接口指南](/mechanisms/evaluator-sdk)。

👉 **[前往出题人文档中心 →](/problemsetters/)**
:::

::: tip 🚀 我是运维人员 / 私有化部署者
- **生产部署**：使用生产级单二进制运维工具 [noj-cli 生产部署](/operators/production-deploy) 快速拉起整套系统。
- **存储配置**：完成 [对象存储配置与运维](/operators/storage) 及评测包流式交付网络规划。
- **评测算力**：掌握 [Judge Worker 评测机集群伸缩与运维](/operators/judge-workers)。
- **系统治理**：查看 [生产密钥轮换 Runbook](/operators/production-secrets)、[可观测性与告警](/operators/observability) 与 [管理后台指南](/operators/admin-guide)。

👉 **[前往运营部署文档中心 →](/operators/)**
:::

</div>

## 🏗️ 核心架构与评测链路

Neuro OJ 各模块通过 RESTful API 与 Redis 消息队列协作，用户代码与评测逻辑全程在独立隔离沙箱中运行：

```mermaid
flowchart TD
    User([用户 / 浏览器 / LMCC IDE]) <-->|HTTPS RESTful API| Core[noj-core 后端服务]
    Core <-->|持久化存储| DB[(PostgreSQL 数据库)]
    Core <-->|对象存储交付| MinIO[(MinIO / S3 题目与头像)]
    
    subgraph 评测调度与沙箱执行
        Core -->|1. 推送评测任务| MQ[(Redis 评测队列)]
        MQ -->|2. 拉取任务| Judge[noj-judge Worker]
        
        subgraph Docker 双容器沙箱
            Judge -->|启动| Eva[Evaluator 评测容器<br/>受控联网 / evaluate.py]
            Judge -->|启动| Sol[Solution 用户容器<br/>严格无网 / 沙箱限制]
            Eva <-->|3. RPC 驱动调用函数 / 数据传输| Sol
        end
        
        Judge -->|4. 回传评分与日志| MQ
        MQ -->|5. 消费评测结果| Core
    end
```

详细原理与安全模型推导请参阅 [系统全景架构](/system/architecture) 与 [双容器评测模型](/mechanisms/judge-model)。
