# noj-core 按域划分与代码级隔离设计

> 日期：2026-09-01
> 状态：Proposed（方向已获确认，待评审后进入实施计划）
> 范围：noj-core 内部结构治理，不拆微服务、不要求物理数据隔离

## 1. 背景

当前 `noj-core` 是一个单进程 Deno + Hono 服务，包含约 50 张表、3.7 万行 TypeScript。虽然 `services/` 下已经有 `auth/`、`community/`、`contest/`、`objective/`、`problems/`、`submissions/`、`users/` 等目录，但边界仍以“目录命名”为主，缺少强制规则：

- 路由层与业务层仍然混合在同一个大 `routes/`、`services/` 命名空间；
- 跨域直接 import service / 直接读表没有约束；
- `db/schema.ts` 仍是一个 1600+ 行的单一文件；
- 后续若想拆分服务或独立部署，缺少清晰的 seam。

本次设计的目标是：**在不拆进程、不拆数据库的前提下，先建立可执行、可验证的代码级域隔离**。

## 2. 目标与非目标

### 2.1 目标

- 为 noj-core 定义明确的业务域及其边界；
- 将 routes / services / types 按域归位；
- 建立“域门面 + 读模型 + 事件”的跨域协作方式；
- 通过 lint / CI 强制禁止跨域深路径依赖；
- 为未来可能的服务化拆分预留 seam。

### 2.2 非目标

- 不拆微服务；
- 不立即拆分 PostgreSQL schema / 迁移；
- 不重写业务逻辑；
- 不做大规模性能优化。

## 3. 域模型

建议将 noj-core 划分为以下域。每个域拥有自己的业务规则、路由、服务和类型；跨域交互必须通过门面或事件。

| 域 | 主要职责 | 主要表 / 资源 |
|---|---|---|
| `identity` | 注册/登录、JWT、TFA、密码重置、OAuth、用户资料、RBAC、用户封禁 | `users`、`oauth_accounts`、`roles`、`permissions`、`user_roles`、`password_reset_tokens`、`tfa_recovery_codes`、`user_bans` |
| `catalog` | 题目、标签、题目包、支持包、题单 | `problems`、`tags`、`problem_tags`、`trainings`、`training_problems` |
| `objective` | 客观题套卷、题目、练习提交 | `objective_questions`、`objective_submissions` |
| `submission` | 编程/产物提交、评测结果、评测队列、重测、自测、SSE 事件 | `submissions`、`evaluation_results`、`self_tests`、`sse_events` |
| `contest` | 竞赛、参赛者、题目关联、澄清、榜单 | `contests`、`contest_problems`、`contest_participants`、`contest_clarifications` |
| `community` | 板块、帖子、评论、点赞、收藏、关注、动态、举报、审核、通知 | `community_*` 系列表 |
| `messaging` | 私信、会话、已读、删除 | `conversations`、`messages`、`conversation_reads`、`message_deletions` |
| `system` | 系统设置、公告、审计日志、IP 封禁、Judge 镜像 | `system_settings`、`announcements`、`audit_logs`、`ip_bans`、`judge_images` |
| `gateway` | LLM Provider、用量、配额；远期建议迁入 `noj-llm-gateway` 独立 schema | `llm_providers`、`llm_usage`、`llm_quotas` |
| `query` | 搜索、统计、排行榜、Dashboard 等读模型 | 不拥有核心业务表，通过其他域的读接口/事件聚合 |

> `roles` / `permissions` 表本身属于 RBAC 模型，建议由 `identity` 拥有；`system` 只负责系统级配置与审计，不拥有 RBAC 主表。

## 4. 目标目录结构

```text
noj-core/src/
├── domains/
│   ├── identity/
│   │   ├── index.ts          # 域门面：唯一对外入口
│   │   ├── routes/
│   │   ├── services/
│   │   └── types/
│   ├── catalog/
│   ├── objective/
│   ├── submission/
│   ├── contest/
│   ├── community/
│   ├── messaging/
│   ├── system/
│   ├── gateway/
│   └── query/
├── shared/                    # 跨域共享内核
│   ├── db/                    # 连接、迁移、schema（可后续按域拆分）
│   ├── lib/                   # JWT、密码、日志、存储、限流、事件总线等
│   ├── middleware/            # 认证、封禁、限流等通用中间件
│   ├── errors/
│   └── types/                 # 跨域共享类型（JudgeTask、JudgeResult、状态枚举等）
├── app.ts
└── main.ts
```

迁移原则：**先建 `domains/` 骨架，再把现有 `routes/`、`services/` 文件按域搬入，不重写业务逻辑**。

## 5. 隔离规则

### 5.1 域门面

每个域提供一个 `index.ts`，只导出该域允许其他域使用的函数和类型。

```ts
// domains/contest/index.ts
export {
  listContests,
  getContest,
  getContestRanking,
} from "./services/contests.ts";
export type { ContestSummary, ContestRankingEntry } from "./types/contest.ts";
```

其他域只允许：

```ts
import { getContest } from "../domains/contest/index.ts";
```

禁止深路径：

```ts
// ❌ 禁止
import { getContest } from "../domains/contest/services/contests.ts";
```

### 5.2 禁止跨域直接调用 service / 直接读表

- 域 A 不得 import 域 B 的 service 实现；
- 域 A 不得直接 `db.select().from(域B的表)`；
- 域 A 需要域 B 数据时，使用域 B 门面提供的**读模型**函数。

示例：

```ts
// submission 需要题目信息
import { getProblemBriefs } from "../domains/catalog/index.ts";

const briefs = await getProblemBriefs(problemIds);
```

### 5.3 事件协作

域状态变更通过现有 `event-bus` 发布域事件，其他域订阅处理。

- `submission` 发布 `submission:finished`；
- `contest` 订阅后更新实时榜单；
- `community` 订阅后生成动态/通知；
- `query` 订阅后更新统计缓存。

事件不携带完整业务状态，接收方需要时通过 REST/读模型重新拉取，保持现有“DB 是事实源、事件是通知”的原则。

### 5.4 共享内核

`shared/` 只放通用基础设施：

- 数据库连接与迁移；
- 错误体系；
- 日志脱敏；
- 存储抽象；
- 限流/封禁中间件；
- 事件总线；
- 跨域共享类型。

域代码可以自由使用 `shared/`，但 `shared/` 不得反向依赖任何 `domains/*`。

## 6. 数据库所有权

当前阶段不拆分 `schema.ts`，但需要建立“表 → 域”的所有权映射，并在 CI 中校验：

- 每个域声明它拥有的表；
- 跨域写入必须被 review 阻止；
- 长期目标是按域拆分 schema 文件或独立 schema。

建议在 `docs/engineering/domain-boundaries.md` 中维护 ownership map，并在 `schema.ts` 中为每个表添加注释标记归属域。

## 7. 实施步骤

按 `jj` change 分步推进，避免一次性大改动。

### Step 1：定义域边界文档

- 新建 `docs/engineering/domain-boundaries.md`；
- 列出域/表/路由/服务归属；
- 与 `AGENTS.md` 和 `noj-core/CLAUDE.md` 建立链接。

### Step 2：增加域边界检查

- 新建 `scripts/check-domains.ts`；
- 在 `noj-core/deno.json` 增加 `check:domains`；
- 扫描：
  - `domains/*/services` 是否 import 其他 `domains/*/services` 深路径；
  - `shared/` 是否反向依赖 `domains/`；
- 先跑出当前违规清单，再逐步修复。

### Step 3：试点域迁移

建议选择 `contest` 作为第一个试点域：

- 创建 `src/domains/contest/`；
- 将现有 `routes/contests.ts`、`services/contest/*`、相关类型迁入；
- 暴露 `index.ts` 门面；
- 更新 `app.ts` 挂载路径；
- 修复该域与其它域的跨域引用。

### Step 4：推广到其他域

按同样模式迁移：

- `identity`
- `catalog`
- `submission`
- `community`
- `objective`
- `messaging`
- `system`
- `query`
- `gateway`

每个域一个独立 jj change，便于 review 与回滚。

### Step 5：跨域引用清理

- 将现有跨域 service 深调用改为门面调用；
- 将通知/统计等副作用改为事件订阅；
- 清空 `check:domains` 违规清单。

### Step 6：评估 schema 拆分

- 如果域边界稳定，再评估将 `schema.ts` 按域拆分为多个文件；
- 进一步评估 `gateway` 域数据迁往 `noj-llm-gateway`。

## 8. 测试与验证

- 现有测试保持通过；
- 新增 `deno task check:domains` 作为 CI 必过项；
- 为试点域增加门面级 smoke 测试；
- 每次迁移域后运行：
  - `deno task test:parallel`
  - `deno task lint`
  - `deno task check:domains`

## 9. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 大范围文件搬移导致 review 困难 | 合并冲突、审查噪音 | 每域一个 change；纯移动与逻辑修改分离 |
| 同库仍可跨表写 | 边界可能被绕过 | ownership map + review + `check:domains` |
| 过度设计 | 为隔离而隔离 | 以门面和 lint 为主，不引入额外框架 |
| 事件化改造成本高 | 部分域改动大 | 不强制一步到事件，先门面/读模型，事件按需推进 |

## 10. 后续动作

- 评审本设计文档；
- 确认试点域（建议 `contest`）；
- 使用 `writing-plans` 生成实施计划；
- 开始 Step 1。
