# Neuro OJ vs Hydro OJ：差异分析与未来发展方向

> 文档日期：2026-07-31（重写，同步至当前实现）
> 对比基于 Neuro OJ (NOJ) @ commit `8968050d`（2026-07-31）与 Hydro OJ **v5.0.3** 完整功能集。
> **核心前提：NOJ 面向 AI 领域认证与竞赛（IOAI / NOAI / LMCC），Hydro OJ 面向传统 OI（信息学竞赛）。**
> 这导致两者在架构理念上存在根本性差异，而非简单的功能多寡。

---

## 目录

1. [LMCC 与 OI：根本范式差异](#1-lmcc-与-oi根本范式差异)
2. [现状功能对比总表](#2-现状功能对比总表)
3. [架构差异](#3-架构差异)
4. [由于范式差异导致的取舍](#4-由于范式差异导致的取舍)
5. [我们的优势](#5-我们的优势)
6. [通用功能缺失（需要追赶）](#6-通用功能缺失需要追赶)
7. [未来发展方向建议](#7-未来发展方向建议)
8. [总结：核心差异化路线](#8-总结核心差异化路线)

---

## 1. LMCC 与 OI：根本范式差异

这是理解 NOJ 与 Hydro OJ 所有差异的起点。两者面对的评价对象和场景完全不同。

| 维度 | 传统 OI（Hydro OJ） | LMCC / AI 评测（NOJ） |
|------|--------------------|----------------------|
| **评价对象** | 人类竞争选手的算法能力 | LLM 的编程与工程综合能力 |
| **问题本质** | 有标准答案的封闭问题 | 可半开放的工程问题 |
| **答案形式** | 输出文件 / stdout | 完整源代码文件 |
| **评价维度** | 正确性 + 效率（时间/内存） | 正确性 + 代码质量 + 工程规范 |
| **测试用例** | 统一的输入→期望输出对 | 由自定义评测脚本决定 |
| **评分逻辑** | 通用 checkers（diff/testlib/SPJ） | 问题独有 evaluate.py（任意逻辑） |
| **评测环境** | 统一编译+运行环境 | 每道题独立 Docker 镜像+命令 |
| **赛制** | ACM/OI/IOI 标准化赛制 | 考试/认证模式 |
| **语言** | C++ 主导 | **LMCC 仅支持 Python** |
| **防作弊** | 代码相似度检测 | 需检测 AI 辅助程度 / LLM 指纹 |
| **核心指标** | AC 时间、排名 | 综合得分、工程能力评估 |

### 1.1 这对架构意味着什么

**Hydro OJ 的架构假设**：所有题目共享同一套评测基础设施（统一的编译、运行、对比系统），题的差异仅在于输入数据和期望输出。

**NOJ 的架构假设**：每道题是独立的评测微世界（自定义 Docker 镜像 + 自定义评测脚本）。题与题之间评测逻辑可能完全不同。

这就是 NOJ 选择 **support package 模式**（每道题打包自己的评测脚本）而非 Hydro OJ 的 test case + checker 模式的原因。这是范式差异导致的不同抽象层次。

### 1.2 一个具体例子

- **Hydro OJ 的一道 OI 题**：10 个测试用例，每个输入→期望输出，用 diff 对比。
- **NOJ 的一道 LMCC 题**：LLM 编写完整的 REST API。评测脚本启动容器、发 HTTP 请求、验证响应、检查代码风格、运行单元测试，综合评分。

### 1.3 LMCC 语言定位

LMCC 官方仅支持 Python，这是 CCF 的明确定位。因此 NOJ **不做**多语言支持——这不是取舍，而是正确定位。我们的评测栈只需要深度优化 Python 单语言场景。

---

## 2. 现状功能对比总表

> 本表以 2026-07-31 当前实现为准（对比文档 2026-07-25 版中约 2/3 的"应追赶"项已实现）。
> ✅ 标注的实现均有 `openspec/changes/archive/` 归档变更佐证。

| 功能领域 | 子功能 | Hydro OJ | Neuro OJ | 备注 |
|---------|--------|----------|----------|------|
| **用户系统** | 注册/登录 | 完整 | 完整 | NOJ 额外有速率限制和失败退避/锁定 |
| | OAuth 登录 | GitHub/Google/OIDC | 无 | 真实差距（P1） |
| | 2FA / WebAuthn | 支持 | 无 | 真实差距（P2） |
| | 用户主页 | 含统计/图表 | 含统计/通过列表/排名 | 对等 |
| | 个人简介(bio) | 支持 | 支持（Markdown） | 对等 |
| | 站内信/通知 | 用户间+系统通知 | 私信+SSE 通知+社区通知 | 对等（07-03 private-messaging） |
| **题目管理** | CRUD | 完整 | 完整 | 对等 |
| | 分类/标签 | 树形多级分类 | 树形多级分类 | 对等 |
| | 难度标记 | 多级 | easy/medium/hard | 基础 |
| | 测试数据管理 | 在线 test case 管理界面 | zip 支持包（evaluate.py） | 范式差异；Hydro 出题体验更友好 |
| | 题目导入导出 | FPS/HustOJ/QDUOJ 导入 | 无 | 真实差距（Issue #28，未动） |
| | 随机选题 | 支持 | 无 | 小功能（P2） |
| | 题解系统 | 投票+回复 | 社区 solution 帖（点赞/评论） | ✅ 已实现（07-31 add-community-system） |
| | 题目讨论 | 完整 | 社区 discussion 帖 | ✅ 已实现（07-31） |
| **评测系统** | 评测执行 | Go 沙箱 daemon（常驻，毫秒级 exec） | Rust + Docker 双容器（即时创建，秒级） | **冷启动性能是真实短板** |
| | 判题模式 | 8 种（default/interactive/hack/objective/submit_answer/generate/run/communication） | 双容器 evaluate.py 任意逻辑 | 范式差异（evaluate.py 更灵活） |
| | 子任务计分 | min/max/sum + 依赖 | evaluate.py 自定 | 决策性不做 |
| | 检查器 | 8 种内置（含 testlib） | evaluate.py 自定 | 决策性不做 |
| | 语言支持 | C/C++/Python/Java/...（YAML 可配） | **仅 Python（LMCC 定位）** | 决策性不做 |
| | 容器预热 | 有限 | 无（池已撤销） | 性能短板（见 P0） |
| | 资源限制 | cgroup v2 | cgroup 内存峰值 + 双段超时 | 对等 |
| | 评测队列 | MongoDB 抢占 | Redis MQ（LPUSH/BRPOP） | NOJ 支持水平扩展 |
| | 提交重测 | 支持 | 支持 | ✅（06-30 submission-rejudge） |
| | 自测（pretest） | run 模式 | 无 | 真实差距（P1） |
| | hack | 支持 | 无 | 决策性不做 |
| | 编译缓存 | 支持 | 无 | LMCC 不需要 |
| **竞赛** | ACM/ICPC 赛制 | 支持 | 支持（罚时+封榜） | ✅ 已实现（07-30 contest-system） |
| | OI/IOI 赛制 | 支持 | 支持 | ✅ 已实现（07-30） |
| | 考试/认证模式 | homework 赛制 | **无** | **Phase 2 核心缺口** |
| | 实时榜单 | WebSocket 推送 | SSE 推送 + 轮询回退 | 对等（06-29 sse-push-fallback） |
| | 封榜/滚榜 | 支持 | 封榜 ✅ / 滚榜无 | 部分 |
| | 赛时提问 Clarification | 支持 | 表已建，API 未实现 | 小缺口（P2） |
| | 气球/打印服务 | 现场赛工具 | 无 | 不做 |
| **训练/作业** | 训练计划 | DAG 章节+前置依赖 | 无 | 真实差距（LMCC 备考价值，P1） |
| | 作业模式 | 独立权限族 | 无 | 与考试模式合并考虑 |
| **社区** | 讨论区 | 完整 | 板块/帖子/评论/举报/审核/处罚 | ✅ 已实现（07-31，17 张表） |
| | 动态流 | blog 插件 | moment 动态+关注流 | ✅ 已实现（07-31） |
| **管理后台** | 用户管理 | 完整 | RBAC 角色/权限管理 | 对等（07-27 rbac-permission-system） |
| | 题目/提交管理 | 完整（含重测） | 完整（含重测） | 对等 |
| | 系统设置 | Schema 热更新 | systemSettings KV 运行时可改 | 对等（07-06 admin-system-settings） |
| | 操作审计日志 | 支持 | 支持（90 天保留，可配） | 对等（07-06 audit-log） |
| | 黑名单 | 用户/IP | 用户/IP（CIDR） | 对等（07-06 admin-ip-blacklist） |
| | 批量导入用户 | userimport | 无 | 小缺口（P2） |
| **基础设施** | 插件系统 | Cordis 插件架构 | 无 | 不做 |
| | 多租户/域 | 完整 domain 隔离 | 无 | 延后做（轻量方案） |
| | 文件存储 | 本地/S3 | 本地/S3 抽象层（StorageProvider） | 对等（07-06 abstract-storage-s3） |
| | 搜索 | Elasticsearch/Sonic | 内置搜索（P 型公开） | 基础够用 |
| | 实时推送 | 完整 pub/sub | SSE + 轮询回退 | 对等 |
| | Metrics | Prometheus | noj-judge 有，core 缺 | Phase 3 |
| | 健康检查 | 支持 | /health + degraded 模式 | NOJ 更细致 |
| **前端** | 渲染方式 | Nunjucks SSR + React | Nuxt 4 + Vue 3 SPA | 技术路线不同 |
| | 代码编辑器 | Monaco | Monaco | 对等 |
| | Markdown 渲染 | markdown-it+KaTeX | markdown-it+KaTeX+DOMPurify | 对等（NOJ 更安全） |
| | 主题切换 | 支持 | 无（仅 Monaco 编辑器暗色） | 小缺口（P2） |
| | UI 组件 | Mantine | Nuxt UI v4 | 对等（07-31 nuxt-ui-v4-migration） |
| **测试** | 单元测试 | 有限 | 71 个测试文件 | NOJ 领先 |
| | 跨模块 E2E | 有限 | 23 个测试文件 | NOJ 领先 |
| | Docker 沙箱 E2E | 有限 | 7 个套件 | NOJ 领先 |

---

## 3. 架构差异

### 3.1 技术栈对比

| 维度 | Hydro OJ | Neuro OJ |
|------|----------|----------|
| **运行时** | Node.js (Koa 3 + Cordis) | Deno (Hono) |
| **数据库** | MongoDB（文档型） | PostgreSQL（关系型）+ Drizzle ORM |
| **消息队列** | MongoDB 轮询/抢占 | Redis MQ（独立消息层） |
| **评测沙箱** | Go 独立 daemon（常驻） | Rust + Docker API（bollard，双容器） |
| **前端** | React 19 + Nunjucks + Webpack | Vue 3 + Nuxt 4 + Vite + Nuxt UI |
| **插件系统** | Cordis 插件框架 | 无插件系统 |
| **包管理** | npm / pnpm | deno.json / npm 兼容 |
| **部署** | Nix flake + 一键安装脚本 | Docker Compose |

### 3.2 关键架构决策差异

| 决策 | Hydro OJ | Neuro OJ | 分析 |
|------|----------|----------|------|
| **存储** | MongoDB（灵活 schema） | PostgreSQL（严格 schema） | Hydro 的通用 document 表需要 NoSQL。NOJ 的关系型设计明确了数据关系 |
| **评测隔离** | 共享编译+独立运行 | 每道题独立 Docker 镜像 | NOJ 更重但更灵活，适合 LMCC |
| **评测编排** | 单容器 + 常驻沙箱 | 双容器（Evaluator 可信 / Solution 不可信）NDJSON 协议 | NOJ 安全边界更清晰，但冷启动开销大 |
| **状态传递** | MongoDB 轮询 | Redis MQ（LPUSH/BRPOP） | NOJ 的 MQ 支持水平扩展 |
| **请求处理** | Koa 中间件 | Hono 路由 | 两者都是现代框架 |
| **API 风格** | 类 GraphQL（Query/Mutation/Subscription） | 传统 RESTful | REST 更普遍 |

### 3.3 项目成熟度

| 指标 | Hydro OJ | Neuro OJ |
|------|----------|----------|
| 项目起始 | 2018 年（7 年+） | **2026 年 6 月（约 2 个月）** |
| 版本 | v5.0.3 | @ commit `8968050d`（2026-07-31） |
| 包/模块数 | 20+ 官方包 + 第三方插件 | 3 个子模块（core / ui / judge） |
| 数据库表/集合 | 15+ 集合 | **38 张表** |
| 测试覆盖 | 有限 | 71 单元 + 23 E2E + 7 judge E2E |
| 开发者 | 社区团队 | 个人/小团队 |

Hydro OJ 是经过 7 年迭代的成熟项目。NOJ 极其年轻，功能差距是自然的时间积累，关键是差异化发展。

---

## 4. 由于范式差异导致的取舍

以下区分三类：**不做**（范式不匹配）、**已完成**（原"延后做"已交付）、**待做**（仍排期在后）。

### 4.1 我们不做：多语言支持

**Hydro OJ**：支持 C/C++/Python/Java/JavaScript/Go 等多种语言，每种有独立编译链。

**NOJ 的决定**：**仅支持 Python。**

**原因**：LMCC 官方明确定位于 Python。投入精力做多语言编译链对 NOJ 没有价值。相反，我们应该深度优化 Python 生态：pip 依赖管理、Python 版本选择、常用库预装。

### 4.2 我们不做：通用 Checker / Subtask 体系

**Hydro OJ**：8 种内置 checker（含 testlib）、subtask 计分（min/max/sum + 依赖）、test case 管理界面。

**NOJ 的决定**：全部交给 evaluate.py。

**原因**：LMCC 评测脚本需要任意复杂逻辑（HTTP 验证、代码审查、API 调用），无法被通用 checker 覆盖。让出题者直接用 Python 写评测逻辑换来无限灵活性。

### 4.3 ✅ 已完成：竞赛赛制引擎

**Hydro OJ**：6 种竞赛规则引擎（ACM/ICPC、OI、IOI、Strict IOI、Ledo、Homework）。

**NOJ 的现状**：ACM/ICPC（罚时+封榜）、IOI、OI 三种赛制已实现（`types/contests.ts` + `services/contest-ranking.ts`，2026-07-30 归档）。比赛含报名、题目标签、排名、比赛内提交、答疑表（API 待实现）。

**下一步**：**考试/认证模式**（固定题集+时长+自动评分+成绩报告）是 Phase 2 主线——这是 LMCC 认证的核心场景，也是 Hydro 的 homework 赛制可对标的能力。封榜、滚榜、气球追踪等现场赛功能大概率不做（滚榜可后置）。

### 4.4 延后做：多租户 Domain 系统

**Hydro OJ**：完整的多租户 domain 隔离，每个 domain 独立用户/角色/权限/题目。

**NOJ 的现状**：当前单体用户空间，为简洁优先。

**规划**：多租户是未来可能的方向（支持多个机构独立使用同一部署），但当前不需要。未来的实现会采用轻量方案（如 org_id 作用域隔离），不需要 Hydro OJ 那么重的 domain 层。

### 4.5 我们不做：Hack 系统

**Hydro OJ**：提交后可 hack 他人代码。

**NOJ 的决定**：完全不考虑。

**原因**：传统 OI 社区文化，与 LMCC 认证无关。

### 4.6 ✅ 已完成：社区/讨论区/题解系统

**Hydro OJ**：完整的讨论、题解（含投票）、站内信。

**NOJ 的现状**：社区系统已交付（2026-07-31 归档，17 张表、60+ 端点）：板块（含授权）、帖子（solution/discussion/moment 三类）、评论、点赞、收藏、关注、动态流、通知、举报、审核、处罚。题解（solution 帖）与题目讨论（discussion 帖）均可在题目页关联展示。

---

## 5. 我们的优势

### 5.1 现代技术栈

| 方面 | Neuro OJ | Hydro OJ | 评价 |
|------|----------|----------|------|
| 运行时 | Deno（原生 TS） | Node.js（需 tsc） | Deno 零配置 |
| 前端 | Nuxt 4 + Vue 3 + Nuxt UI | Webpack + React + Nunjucks | Nuxt 体验更现代 |
| 数据库 | PostgreSQL + Drizzle（类型安全） | MongoDB（无 schema 约束） | 更可靠 |
| 评测沙箱 | Rust（内存安全） | Go sandbox daemon | Rust 资源控制更精细 |
| 测试 | 71 单元 + 23 E2E + 7 judge E2E | 有限 | 测试更体系化 |

### 5.2 评测架构优势（双容器编排）

NOJ 的 noj-judge 采用 **双容器 NDJSON 协议** 编排，每评测一道题启动 Evaluator + Solution 两个隔离容器（2026-07-24 dual-container-judge 归档）：

- **Evaluator 容器**：跑 `evaluate.py`，通过 `SolutionRunner.call()` 调用 Solution 函数
- **Solution 容器**：跑用户提交代码，被注入到独立进程，通过 NDJSON 帧通信
- **网络隔离**：双方容器都 `network_mode none`；Solution 无法访问外部网络
- **状态隔离**：Solution PYTHONPATH 不影响 Evaluator；Solution 看不到 Evaluator 环境变量
- **Redis RPC**：启动时通过 `get_image_allowlist` RPC 拉取镜像白名单（含 `kind` 字段区分 Evaluator/Solution）
- **支持包内容寻址**：SHA-256 缓存 `noj-download://` URL；本地 + S3 双 backend
- **RAII Drop**：任何错误路径都 `docker rm -f` 双容器

> 历史：2026-07-02 之前曾有 `PoolManager` 固定容器池（含懒回补、健康检查），于 PR #140 + OpenSpec 变更 `remove-single-container-mode`（归档）撤销。主规范 `container-pool` 已归档为 superseded。**代价：评测冷启动变为秒级，这是当前最大性能短板（见 §6 P0）。**

Hydro OJ 每次启动新容器但使用常驻沙箱进程（毫秒级 exec），无容器间隔离。NOJ 的双容器隔离在安全边界上更清晰，但需解决冷启动问题。

### 5.3 安全设计

- 生产模式下自动截断 submission_id、隐藏分值、脱敏数据库密码
- 登录速率限制：IP 窗口 + 账号窗口 + 失败退避 + 账号锁定
- bcrypt cost 12
- 社区内容审核（举报→审核→处罚）+ 板块级授权

### 5.4 天然水平扩展

Redis MQ（LPUSH/BRPOP）生产者-消费者模式原生支持多个 noj-judge 实例并行。

### 5.5 测试体系

完整测试金字塔：单元测试（71 个测试文件）、跨模块 E2E（23 个文件）、Docker 沙箱 E2E（7 个套件）。Hydro OJ 作为成熟项目测试覆盖反而较弱。

---

## 6. 通用功能缺失（需要追赶）

以下是不涉及范式差异、纯粹是通用 OJ 平台的功能缺失。**与 2026-07-25 版相比，原 P0/P1 大部分已完成**（S3 存储、系统设置、审计日志、黑名单、RBAC、比赛、社区），剩余缺口按当前优先级重排：

### P0 - 核心缺失

| 功能 | 说明 | 工作量 |
|------|------|--------|
| **考试/认证模式** | 固定题集+时长+自动评分+成绩报告+防作弊+证书；LMCC 认证核心场景，ROADMAP Phase 2 主线 | 大 |
| **评测冷启动优化** | 每次评测即时创建 2 个 Docker 容器（秒级），Hydro 常驻沙箱毫秒级；影响排队体验 | 中 |

### P1 - 重要功能

| 功能 | 说明 | 工作量 |
|------|------|--------|
| **题目导入导出** | FPS / HustOJ / QDUOJ 格式（Issue #28，一直未动） | 中 |
| **训练计划** | DAG 章节+前置依赖，对标 LMCC 备考路线图 | 中 |
| **OAuth 登录** | GitHub/Google/OIDC 一键登录，降低注册门槛 | 中 |
| **提交前自测（pretest）** | 提交前本地运行，提升做题体验 | 小 |

### P2 - 锦上添花

| 功能 | 说明 | 工作量 |
|------|------|--------|
| 测试用例/支持包在线管理 | 出题人无需 zip 上传，在线编辑测试点 | 中 |
| 比赛 Clarification API | 表已建（contestClarifications），补 API + UI | 小 |
| 滚榜 | 现场赛风格榜单回放 | 中 |
| 随机选题 | 练习模式随机抽题 | 小 |
| 批量导入用户 | admin 一键导入（含小组/角色） | 小 |
| 主题切换 | 亮/暗色模式（目前仅 Monaco 编辑器暗色） | 小 |
| 2FA / WebAuthn | 账号安全增强 | 中 |

### 决策性不做（维持）

多语言、通用 checker/subtask、交互题、hack、插件系统、气球/打印服务。

---

## 7. 未来发展方向建议

### 7.1 近期：考试/认证模式 + 评测性能

**考试/认证模式（Phase 2 主线，对标 Hydro homework 赛制）：**
- 创建考试 → 指定题集 → 设定时长 → 自动评分
- 成绩报告：多维度能力评估报告（不单是分数）
- 防作弊：IP 记录、浏览器指纹、代码风格分析
- 证书生成：通过后自动生成 PDF

**评测冷启动优化：**
- 双容器预热池（镜像级预热：常驻 Evaluator 基础镜像容器，评测时只注入代码）
- 或评测调度器并发预热 + 队列可见性

### 7.2 中期：内容建设与体验

- 题目导入导出（FPS，Issue #28）——题库迁移/建设成本
- 训练计划（DAG 章节）——LMCC 备考路线图
- OAuth 登录
- 提交前自测
- 测试用例在线管理界面

### 7.3 长期：差异化蓝海

以下方向是 Hydro OJ 无法（或不适合）做的：

**1. AI 辅助评测**
- 使用 AI 对代码质量自动评分
- LLM 输出指纹识别——区分"理解后写出"与"直接抄写"
- 多角度评估报告：可读性、效率、安全性、健壮性

**2. 面向 LLM 的题目生态**
- 工程型题目：补全代码 / 代码审查 / Bug 定位 / 重构 / API 设计
- 传统 OJ 题是"给定输入，计算输出"；LMCC 题是"给定需求，实现功能"

**3. 非同步考试模式**
- LLM 认证不需要同时参加
- 随到随考（大规模题库+随机抽题）
- AI 监考：浏览器中检测可疑行为

**4. 开放的评测协议**
- 标准化 NOJ 的评测协议
- 任何人都可以编写评测脚本作为题目
- 建立 LMCC 题目市场

**5. IDE 工具链集成**
- 与 Cursor、VS Code 等 IDE 集成
- LLM 在 IDE 中完成题目后一键提交
- API 优先设计，方便 CI/CD 集成

### 7.4 不应做的方向

| 方向 | 原因 |
|------|------|
| 插件系统 | 小团队维护成本高 |
| 多语言支持 | LMCC 官方仅 Python |
| hack / 交互题 | 与 LMCC 认证无关 |

---

## 8. 总结：核心差异化路线

```
                    Hydro OJ（传统 OI，7 年，v5.0.3）
                   /                        \
        通用 OJ 功能（对比表 2 的应追赶项）
                   \                        /
                    Neuro OJ（LMCC 认证，2 个月）
                           |
          ┌────────────────┼────────────────┐
          ▼                ▼                ▼
    通用补齐          LMCC 差异化        蓝海方向
    ──────────    ──────────────    ────────────────
    考试/认证模式   LLM 代码指纹      AI 辅助评分
    评测冷启动      Python 生态深耕    工程型题目
    FPS 导入导出    多维度评估报告     非同步考试
    训练计划       防作弊/监考        IDE 集成
    OAuth/自测      证书生成          开放评测协议
```

不要试图在通用 OJ 功能上与 Hydro OJ 正面竞争。通用功能补齐到"够用"即可。

**深耕 LMCC 这个 Hydro OJ 无法覆盖的新市场——这才是长期护城河。**

### 一句话总结

- **明确不做**（范式不匹配）：多语言、通用 checker/subtask 体系、交互题、Hack、插件系统
- **已完成**（2026-06~07 追赶）：SSE、重测、搜索、审计日志、黑名单、S3 存储、系统设置、RBAC、比赛（ACMI/IOI/OI）、社区/题解/讨论、私信
- **加速做**（当前缺口）：考试/认证模式（Phase 2 主线）、评测冷启动优化、FPS 导入导出、训练计划、OAuth、自测
- **蓝海做**（差异化）：AI 辅助评分、混合评测、非同步考试、IDE 集成、开放评测协议
