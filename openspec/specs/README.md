# OpenSpec 主规范索引

本目录包含 Neuro OJ 主规范（行为规范，Requirements + Scenarios），每个子目录对应一个独立的能力域。
新规范落地流程：起草 `openspec/changes/<name>/` → 评审 → 合并 → 同步 spec 增量到本目录 → 归档。

> **目录约定**：`openspec/specs/<name>/spec.md`，name 为 kebab-case。
> **来源映射**：见 `openspec/changes/archive/` 下的历史归档，了解每个规范的来历。

---

## 主题分类索引（按子系统组织）

### 🔐 用户与认证

| 规范 | 状态 | 说明 |
|------|------|------|
| [`user-auth`](./user-auth/spec.md) | 活跃 | 用户注册、登录、JWT 鉴权（HS256，iss/aud 校验） |
| [`cookie-auth`](./cookie-auth/spec.md) | 活跃 | HTTP-only Cookie 注入策略 + Nitro 反向代理 |
| [`user-profile`](./user-profile/spec.md) | 活跃 | 用户主页（统计、通过列表、bio Markdown） |
| [`user-settings`](./user-settings/spec.md) | 活跃 | 个人设置（改密、邮箱、偏好） |
| [`user-ban`](./user-ban/spec.md) | 活跃 | 用户封禁记录（userBans 表） |
| [`user-ban-audit`](./user-ban-audit/spec.md) | 活跃 | 用户封禁审计日志（admin 操作可追溯） |
| [`ban-status-endpoint`](./ban-status-endpoint/spec.md) | 活跃 | `/api/v1/ban-status` 公开封禁状态查询 |
| [`ip-blacklist`](./ip-blacklist/spec.md) | 活跃 | IP 黑名单（ipBans 表 + admin API） |

### 📚 题目管理

| 规范 | 状态 | 说明 |
|------|------|------|
| [`problem-management`](./problem-management/spec.md) | 活跃 | admin 题目 CRUD（创建/编辑/删除/查询） |
| [`problem-ownership`](./problem-ownership/spec.md) | 活跃 | U/P 双题库所有权（owner/admin CRUD） |
| [`problem-runtime-config`](./problem-runtime-config/spec.md) | 活跃 | 题目 `runtime_config` JSONB 必填（双容器编排） |
| [`problem-list-page`](./problem-list-page/spec.md) | 活跃 | 题目列表页（搜索、筛选、分页） |
| [`category-management`](./category-management/spec.md) | 活跃 | 分类树形多级管理 |
| [`submission-list-api`](./submission-list-api/spec.md) | 活跃 | 提交列表 API（分页、筛选） |
| [`submission-history-page`](./submission-history-page/spec.md) | 活跃 | 提交历史页（前端） |
| [`submission-status-tracking`](./submission-status-tracking/spec.md) | 活跃 | 提交状态追踪（Pending → Judging → 终态） |

### ⚖️ 评测核心

| 规范 | 状态 | 说明 |
|------|------|------|
| [`judge-worker`](./judge-worker/spec.md) | 活跃 | noj-judge Worker 主规范（双容器 NDJSON 协议，15 Requirements） |
| [`judge-image-whitelist`](./judge-image-whitelist/spec.md) | 活跃 | 评测镜像白名单（kind: evaluator/solution） |
| [`judge-rpc`](./judge-rpc/spec.md) | 活跃 | core↔judge Redis RPC（`get_image_allowlist` 等） |
| [`docker-sandbox`](./docker-sandbox/spec.md) | 活跃 | Docker 沙箱（cap_drop ALL / no-new-privileges / network_mode none） |
| [`support-package-upload`](./support-package-upload/spec.md) | 活跃 | 支持包上传（`noj-download://` 双层 URL） |
| [`object-storage`](./object-storage/spec.md) | 活跃 | 抽象存储层（`StorageProvider` local/s3） |
| [`rejudge-testing`](./rejudge-testing/spec.md) | 活跃 | rejudge 路径测试（含 `runtime_config` 回归） |

### 📨 消息与队列

| 规范 | 状态 | 说明 |
|------|------|------|
| [`redis-message-queue`](./redis-message-queue/spec.md) | 活跃 | Redis MQ（LPUSH/BRPOP，Producer-Consumer） |
| [`queue-overview`](./queue-overview/spec.md) | 活跃 | `/queue` 队列状态页（前端） |

### 📡 SSE 推送

| 规范 | 状态 | 说明 |
|------|------|------|
| [`sse-endpoints`](./sse-endpoints/spec.md) | 活跃 | SSE 端点定义 |
| [`sse-event-bus`](./sse-event-bus/spec.md) | 活跃 | 进程内事件总线 |
| [`sse-polling-fallback`](./sse-polling-fallback/spec.md) | 活跃 | SSE 不支持时降级到轮询 |
| [`sse-testing`](./sse-testing/spec.md) | 活跃 | SSE 测试规范 |

### 💬 站内互动

| 规范 | 状态 | 说明 |
|------|------|------|
| [`private-messaging`](./private-messaging/spec.md) | 活跃 | 站内私信（conversations + messages + 已读） |
| [`message-ui`](./message-ui/spec.md) | 活跃 | 私信 UI |
| [`checkin`](./checkin/spec.md) | 活跃 | 每日签到（checkIns 表） |

### 🏆 榜单

| 规范 | 状态 | 说明 |
|------|------|------|
| [`ranking`](./ranking/spec.md) | 活跃 | 榜单（通过数 / 通过率 / AC 曲线） |

### 🛡️ 管理后台

| 规范 | 状态 | 说明 |
|------|------|------|
| [`admin-authorization`](./admin-authorization/spec.md) | 活跃 | admin 权限系统（中间件 + 角色提升 + 种子） |
| [`admin-dashboard`](./admin-dashboard/spec.md) | 活跃 | admin 后台仪表盘 |
| [`admin-problem-management`](./admin-problem-management/spec.md) | 活跃 | admin 题目管理（与 problem-management 的 admin 视图） |
| [`admin-submission-management`](./admin-submission-management/spec.md) | 活跃 | admin 提交管理 |
| [`admin-submission-rejudge`](./admin-submission-rejudge/spec.md) | 活跃 | admin 触发重测 |
| [`admin-user-management`](./admin-user-management/spec.md) | 活跃 | admin 用户管理（封禁、改密、角色） |
| [`admin-category-management`](./admin-category-management/spec.md) | 活跃 | admin 分类管理 |
| [`admin-ip-blacklist`](./admin-ip-blacklist/spec.md) | 活跃 | admin IP 黑名单管理 |
| [`admin-system-settings`](./admin-system-settings/spec.md) | 活跃 | admin 系统设置（运行时键值） |
| [`audit-log`](./audit-log/spec.md) | 活跃 | 审计日志（90 天保留，可配置） |

### 📧 邮件与通知

| 规范 | 状态 | 说明 |
|------|------|------|
| [`email-provider`](./email-provider/spec.md) | 活跃 | 邮件 provider 抽象（mock / aliyun / tencent） |

### 🗄️ 数据库与基础设施

| 规范 | 状态 | 说明 |
|------|------|------|
| [`database-schema`](./database-schema/spec.md) | 活跃 | 17 张表 schema（Drizzle 定义） |
| [`settings-integer-type`](./settings-integer-type/spec.md) | 活跃 | 系统设置整数类型校验 |
| [`pglite-test-infrastructure`](./pglite-test-infrastructure/spec.md) | 活跃 | 嵌入式 PG 测试基础设施 |

### 🧪 测试

| 规范 | 状态 | 说明 |
|------|------|------|
| [`judge-e2e-test`](./judge-e2e-test/spec.md) | 活跃 | noj-judge Docker 沙箱 E2E（7 套件） |
| [`judge-integration-test`](./judge-integration-test/spec.md) | 活跃 | noj-judge 集成测试 |
| [`mq-unit-tests`](./mq-unit-tests/spec.md) | 活跃 | Redis MQ 单元测试 |
| [`e2e-optimization`](./e2e-optimization/spec.md) | 活跃 | 跨模块 E2E 优化（17 测试 ≤ 8 min） |
| [`audit-log-e2e`](./audit-log-e2e/spec.md) | 活跃 | 审计日志 E2E |
| [`messaging-e2e`](./messaging-e2e/spec.md) | 活跃 | 私信 E2E |

### 🚀 CI/CD 与前端

| 规范 | 状态 | 说明 |
|------|------|------|
| [`ci-optimization`](./ci-optimization/spec.md) | 活跃 | GitHub Actions 优化（缓存、Drizzle 迁移） |
| [`ci-smoke-tests`](./ci-smoke-tests/spec.md) | 活跃 | CI 冒烟测试 |
| [`tailwind-migration`](./tailwind-migration/spec.md) | 活跃 | noj-ui 从原生 CSS 迁移到 Tailwind |

---

## 数字统计

- 总计 **56** 个活跃主规范
- 主题分布：
  - 用户与认证：8
  - 题目管理：8
  - 评测核心：7
  - 消息与队列：2
  - SSE 推送：4
  - 站内互动：3
  - 榜单：1
  - 管理后台：10
  - 邮件与通知：1
  - 数据库与基础设施：3
  - 测试：6
  - CI/CD 与前端：3

> **已归档主规范**（被 OpenSpec 变更撤销）：见 [`changes/archive/`](../changes/archive/) 下 `*-superseded/` 目录。当前仅 `2026-07-25-container-pool-superseded/` 一个归档 spec。

---

## 如何贡献新规范

1. **起草**：`openspec/changes/<name>/` 下创建 `proposal.md` / `tasks.md` / `specs/<target>/spec.md`
2. **评审**：通过 PR review 流程
3. **实施**：按 tasks.md 推进
4. **同步**：合并后将 spec 增量同步到本目录（`openspec/specs/<target>/spec.md`）
5. **归档**：`openspec/changes/<name>/` → `openspec/changes/archive/YYYY-MM-DD-<name>/`

详细工作流见仓库根 `AGENTS.md §10`。