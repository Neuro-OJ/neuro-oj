# Neuro OJ — 开发路线图

Neuro OJ (NOJ) 是一个面向 **AI 领域认证与竞赛** 的在线评测平台，覆盖 **IOAI /
NOAI / LMCC** 等场景。独立社区项目，与 CCF、LMCC、IOAI、NOAI 无任何官方关系。

> 定位与产品边界见 [PRODUCT.md](PRODUCT.md)，视觉与页面依据见
> [DESIGN.md](DESIGN.md)。

## 技术栈与模块

| 模块 / 组件          | 技术栈                          | 职责                                                               |
| -------------------- | ------------------------------- | ------------------------------------------------------------------ |
| `noj-core`           | Deno 2 + Hono                   | RESTful API、JWT 与固定域角色授权、业务服务、Redis MQ、审计        |
| `noj-ui`             | Nuxt 4 + Vue 3 + Nuxt UI        | Web 前端、Nitro BFF 代理与 JWT Cookie 注入                         |
| `noj-judge`          | Rust + Tokio + Docker           | 双容器沙箱评测（OI / Dual / Prediction）、本地验题                 |
| `noj-llm-gateway`    | Deno + Hono                     | LLM 可信代理、Key 加密、`eval_token`、RPM/TPM 限流队列与审计       |
| `noj-cli`            | Deno 2（单二进制）              | 生产安装/升级/备份恢复演练、v0.10→v0.11 逻辑升级、`problem` 工具链 |
| `noj-lmcc-extension` | VS Code Extension API           | IDE 登录、选题、Python 代码提交与评测反馈                          |
| 基础设施             | PostgreSQL 16 / Redis 7 / MinIO | 持久化存储、任务队列、对象存储                                     |

---

## 当前基线：截至 `v0.11` 已交付能力

### 1. 平台与多域治理

- [x] **统一实例账号与多域隔离**：实例级账号（JWT、2FA、凭据变更撤销旧会话、按
      IP 隔离登录锁定）与 `community` / `teaching` / `team`
      三类域隔离；共享源题可跨域使用，提交、教学与额度归属使用域。
- [x] **统一域 URL 架构**：题库、比赛、社区与教学统一按 `/d/:slug/...`
      组织；旧无域入口已收敛为一套重定向规则。

### 2. 全题型评测与版本管理

- [x] **七类题型**：OI（支持 `testlib` SPJ，见
      [`oi/runner.rs`](../../noj-judge/src/oi/runner.rs)）、AI
      函数调用代码题（双容器 Evaluator + Solution）、LLM 工程题（经
      `noj-llm-gateway`
      代理）、客观题套卷、产物提交（zip）、预测提交（[`prediction/`](../../noj-judge/src/prediction/)）与界面题（题包自带
      HTML 界面驱动评测）。
- [x] **不可变题目版本**：草稿编辑与发布预检、版本化评测、有效成绩口径与批量重测。
- [x] **出题与本地验题工具链**：题包直接建题、`noj-cli problem init/test/push`
      与五类出题模板（本地验题入口见
      [`local.rs`](../../noj-judge/src/local.rs)）。
- [x] **评测调度可靠性**：三级优先级队列（`high` / `medium` /
      `low`）、派发标记与卡住提交对账、偶发平台错误自动重试。

### 3. 教学与知识图谱

- [x] **教学工作台**（[`modules/education/`](../../noj-core/src/modules/education/)）：班级学生管理、作业草稿/定时发布与版本固定、作业学情矩阵与
      CSV 导出、源码行批注与私人求助、全班补题与训练前后对比。
- [x] **知识图谱**（[`features/knowledge/`](../../noj-core/src/features/knowledge/)）：知识包幂等导入、AI
      知识点打标与人工审核、难度校准、教练视角班级掌握矩阵与按知识点均匀挑题。

### 4. 竞赛与反作弊

- [x] **类 Kaggle
      积分竞赛**：时间窗口、按各题最高分累计排名、每题提交次数限制与赛时实时榜单
      SSE（[`sse.ts`](../../noj-core/src/modules/contests/routes/sse.ts)）。
- [x] **比赛保密与正式成绩**：`secrecy_enabled`
      从收录到赛后保护历史版本；支持封榜窗口与版本化正式成绩快照发布、CSV/JSON
      导出（[`ranking-export.ts`](../../noj-core/src/modules/contests/routes/ranking-export.ts)）。
- [x] **反作弊基础**：IP
      记录与代码相似度检测（[`contest-anti-cheat.ts`](../../noj-core/src/modules/contests/services/contest-anti-cheat.ts)）。

### 5. 生产运维与质量保障

- [x] **一站式生产 CLI**：`noj-cli` 覆盖安装、启停、升级前磁盘预估与回滚、单文件
      `.nojbackup` 备份与隔离恢复演练（`backup drill`）、`noj db upgrade-v010`
      逻辑升级（见
      [升级文档](../../noj-docs/docs/operators/upgrade-v010-to-v011.md)）。
- [x] **可观测性与安全基线**：Prometheus + Grafana
      监控告警（[`deploy/monitoring/README.md`](../../deploy/monitoring/README.md)）、脱敏结构化
      JSON 日志、沙箱加固与限流矩阵。
- [x] **自动化流水线**：CI
      静态检查/单测/漏洞扫描（[`ci.yml`](../../.github/workflows/ci.yml)）与跨模块
      Docker E2E（[`e2e.yml`](../../.github/workflows/e2e.yml)）。

---

## 近期焦点（`v0.11.x` – `v0.12`，高优先级）

> 聚焦**架构收敛、赛后体验闭环与生产并发稳定性**。

### 架构收敛与工程提效

> 详见
> [`dev-docs/refactor/core-feature-slices/tasks.md`](../refactor/core-feature-slices/tasks.md)。

- [ ] **底座下沉与合同合并**：将系统设置读取等底座能力从 `platform` 迁入
      `shared/`，合并跨模块转出文件并消除模块间运行时循环。
- [ ] **旧模块按需迁入 `features/`**：在现有 `checkin` / `knowledge` / `legal` /
      `tags` / `trainings` 样例基础上，逐步迁出剩余 `modules/` 目录并清理
      `application/`、`module-boundaries.json` 与旧边界门禁。
- [ ] **前后端接口类型共享**：确定 `noj-core` 与 `noj-ui` 的类型共享方案（Hono
      RPC 类型推导或 schema 生成），打通端到端样例并逐步替换前端手写类型。
- [ ] **前端目录重组与设计系统收口**：按领域重组 `noj-ui` 目录、统一设计
      token（[noj-design-tokens.md](../design/noj-design-tokens.md)）并完成亮色全站/暗色编辑器视觉验收。

### 赛后复盘闭环

- [ ] **官方题解与正式成绩切换**：在比赛页补齐赛后官方题解入口，并支持赛后切换查看正式成绩版本。
- [ ] **提交时间轴回放**：基于已落库的 `receipt_sequence`
      新增赛后时间轴查询端点与前端回放视图。

### 生产并发与评测性能

- [ ] **多 Judge Worker
      扩展**：支持多节点水平扩展、任务认领负载均衡与独立评测节点运维闭环。
- [ ] **评测冷启动优化**：容器预热与评测镜像层缓存策略，缩短高频提交响应耗时。
- [ ] **基准与压力测试**：建立高并发提交与长周期评测的压测基准及容量基线。

---

## 中期主线：AI 竞赛进阶与考试能力

> 围绕 **隐藏测试集评测、自定义指标与复杂赛制**
> 补齐差异化能力，按以下依赖顺序推进。

### 1. 隐藏测试集与 IOAI / NOAI 赛制链路

- [ ] **评测插件机制**：支持出题人/赛事方提供自定义评估指标脚本与隐藏测试集评测钩子。
- [ ] **隐藏测试集评测与 A/B 榜隔离**：支持两套独立测试集、公开榜（A
      榜）与私有榜（B
      榜）数据隔离规则，以及前端榜单切换展示（注：现有封榜与正式快照**不等同于**
      A/B 榜）。
- [ ] **IOAI / NOAI 赛制模板与题包标准**：提供 At-Home 长周期 +
      现场短时两阶段赛制模板，并支持对应竞赛题目包导入与校验。

### 2. 考试模式（需先立项确认详细契约）

- [ ] **限时闭卷考试赛制**：明确开考/交卷锁定、作答过程约束（如防切屏或网络/IP
      白名单策略）及自动统一收卷机制后再实施。

---

## 远期探索（暂不承诺排期）

- [ ] **传统 OI 交互题支持**：评测机支持交互器进程双向通信协议。
- [ ] **按需 GPU 训练执行器**：面向需要真实算力训练的 AI
      赛题，接入可调度、可隔离的按需 GPU 执行后端。

---

## 版本演进里程碑

| 阶段 / 版本         | 核心交付标准                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| `v0.10` – `v0.11`   | 七类题型、多域隔离、教学工作台、知识图谱、类 Kaggle 比赛、LLM 可信网关与 `noj-cli` 运维工具链全面可用    |
| `v0.11.x` – `v0.12` | `noj-core` / `noj-ui` 架构收敛与端到端类型共享落地；赛后复盘闭环补齐；多 Judge Worker 并发扩展与压测达标 |
| `v0.13+`            | 评测插件、隐藏测试集 A/B 榜隔离与 IOAI / NOAI 赛制模板可用                                               |
