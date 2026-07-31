# Neuro OJ — 开发路线图

Neuro OJ (NOJ) 是一个独立的在线评测系统，面向 AI
时代的程序设计与工程能力评测。与 LMCC/CCF 无任何官方关系。

## 技术栈

| 模块      | 技术                        | 用途               |
| --------- | --------------------------- | ------------------ |
| noj-core  | Deno + Hono                 | RESTful API 服务端 |
| noj-ui    | Nuxt 4 + Vue 3              | Web 前端           |
| noj-judge | Rust + Docker               | 评测 Worker        |
| 中间件    | Redis                       | 消息队列           |
| 数据库    | PostgreSQL 16               | 持久化存储         |

## Phase 0：端到端 MVP

> 打通"提交 → 评测 → 结果"闭环

**noj-core**

- [x] 用户系统：注册、登录（JWT）
- [x] 题目 API：单题 CRUD，至少 1 道示例题含测试用例
- [x] 提交 API：接收代码，生成 submission_id
- [x] 评测结果 API：查询评测状态与结果
- [x] Redis MQ Producer：发布评测任务

**noj-ui**

- [x] 登录 / 注册页面
- [x] 题目页面：描述 + 代码编辑器
- [x] 提交结果页：状态、通过用例、耗时、内存
- [x] API 客户端封装（Nitro proxy）

**noj-judge**

- [x] Redis MQ Consumer：拉取评测任务
- [x] Docker 沙箱：创建容器，注入代码，限制资源
- [x] 语言支持：Python 3
- [x] 评测逻辑：运行 → 逐用例对比 → AC / WA / TLE / MLE / RE
- [x] 结果回传 Redis

**基础设施**

- [x] 数据库建表与迁移
- [x] Redis 消息队列
- [x] Docker 环境

---

## Phase 1：核心 OJ 功能

> 标准 OJ 全功能集合（榜单 / 筛选 / 管理后台）

**noj-core**

- [x] 题目管理：CRUD + 难度标签 + 分类（树形多级）
- [x] 提交历史：分页、筛选
- [x] 排行榜：通过数 / 通过率 / AC 曲线
- [x] 用户主页：统计、通过列表
- [x] 管理 API：题目 CRUD、分类管理、镜像白名单、审计日志、黑名单
- [x] 系统设置运行时可改（`systemSettings` 表）
- [x] 审计日志（90 天保留）+ IP/用户黑名单
- [x] 站内私信（conversations + messages）
- [x] 每日签到
- [x] 文件存储抽象（`STORAGE_PROVIDER=local|s3`）
- [x] SSE 推送（含 polling 回退）
- [x] 速率限制（IP/账号窗口 + 失败退避 + 锁定）

**noj-ui**

- [x] 题目列表页：搜索、筛选、分页
- [x] 排行榜页面
- [x] 用户主页（含 bio Markdown）
- [x] 提交历史页
- [x] 管理后台：题目编辑器（含双容器 runtime_config）
- [x] 镜像白名单管理
- [x] 审计日志/黑名单查看
- [x] 站内私信 UI
- [x] 个人设置（改密、邮箱）

**noj-judge**

- [x] 双容器 NDJSON 编排（Evaluator + Solution）— 取代单容器
- [x] 镜像白名单（evaluator / solution 两类 kind）
- [x] ZIP 解压防护（路径穿越 / 炸弹 / overlapping entries）
- [x] 资源消耗数据（time_ms / memory_kb）
- [x] 容器 RAII 清理
- [x] 内容寻址缓存（`noj-download://` + SHA-256）

**遗留（决策性不做）**

- [ ] ~~多语言：C++/Java/Node.js~~ — LMCC 仅 Python（见 `openspec/comparison-hydrooj.md` §1.3 / §4.1）
- [ ] ~~SPJ / 通用 checker~~ — 全部交给 evaluate.py
- [ ] ~~交互题支持~~ — LMCC 场景无需求

**待追赶（Issue #28 跟踪 + 对比文档 §6）**

- [ ] 题目导入导出（FPS / HustOJ / QDUOJ 格式）— Issue #28
- [ ] 评测冷启动优化（双容器秒级创建 → 预热池）— 见 `openspec/comparison-hydrooj.md` §6 P0
- [ ] 训练计划（DAG 章节，LMCC 备考）— 见 §6 P1
- [ ] OAuth 登录、提交前自测 — 见 §6 P1

---

## Phase 2：竞赛与考试

> 自带竞赛/考试系统，独立运行
> **竞赛部分已提前交付（2026-07-30 `contest-system` 归档）：icpc/ioi/oi 三赛制 + 封榜 + SSE 实时排名。**

**noj-core**

- [x] 竞赛管理：创建比赛、时间窗口、题目集（icpc/ioi/oi 三赛制 + 封榜，2026-07-30）
- [x] 比赛规则：ACM / OI / IOI（含封榜逻辑，见 `services/contest-ranking.ts`）
- [ ] 比赛答疑 Clarification API（`contestClarifications` 表已建，API/UI 未实现）
- [ ] 考试模式：创建考试 → 指定题集 → 设定时长 → 自动评分
- [ ] 成绩报告：多维度能力评估（不只是分数）
- [ ] 防作弊：IP 记录、浏览器指纹、代码风格分析
- [ ] 证书生成：通过后自动生成 PDF
- [ ] 题目分组 / 自适应难度

**noj-ui**

- [x] 竞赛榜单（icpc 罚时 / ioi / oi 排名，SSE 推送）
- [ ] 考试大厅：列表、倒计时、题目切换
- [ ] 成绩报告可视化
- [ ] 赛后复盘：题解、排行榜回放

---

## Phase 3：生产就绪

> 稳定、安全、可扩展

- [ ] Judge worker 水平扩展 + 负载均衡
- [ ] 任务优先级队列
- [ ] 数据库备份与迁移策略
- [ ] 监控告警（Prometheus + Grafana）
- [ ] 结构化日志
- [ ] CI/CD 流水线
- [ ] 安全审计：Docker 逃逸、资源耗尽、DDoS
- [ ] 压力测试

## 里程碑

| 阶段    | 交付标准                                    | 状态 |
| ------- | ------------------------------------------- | ---- |
| Phase 0 | 浏览器注册 → 做题 → 提交 → 看到评测结果     | ✅    |
| Phase 1 | 榜单可查，题目可筛选，管理后台可用（另已交付：比赛、社区、RBAC） | ✅    |
| Phase 2 | 可创建考试 → LMCC 认证闭环                  | 🚧 进行中（比赛已交付，考试模式待做） |
| Phase 3 | 多 worker 并发评测，99.5% 可用性            | ⏳ 规划 |

**当前未完成的可见缺口**

- 考试/认证模式（Phase 2 主线；含成绩报告、防作弊、证书）— 见 `openspec/comparison-hydrooj.md` §6 P0
- 评测冷启动优化（双容器即时创建 vs Hydro 常驻沙箱）— 对比文档 §6 P0
- Issue #28：题目导入导出管理 API
- Issue #103：生产环境 Docker Compose 编排
- 已知遗留（设计决策）：多语言、SPJ、交互题
- 比赛 Clarification API（表已建，API/UI 待实现）
