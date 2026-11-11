## Context

See `proposal.md` for the motivation. 现状结构（`noj-core/src`）：

```text
app.ts / main.ts / mod.ts
shared/            # 约 1.4 万行：db、mq、http、config、security、sse、observability、workspace 等
modules/
  access/ problems/ evaluations/ contests/ education/ communication/
  platform/ assets/ read-models/ runtime/
  application/     # 写用例编排层（problems.ts / evaluations.ts / create-system.ts …）
  http/            # create-app.ts 与 admin 路由聚合
```

模块内部普遍为
`contracts/ routes/ services/ types/ tests/ index.ts`，跨模块调用经
`contracts/cross-module/*.ts` 转出。边界与测试路径登记在
`dev-docs/engineering/module-boundaries.json`， 由
`scripts/check-module-boundaries.ts`、`scripts/check-contract-reexports.ts`、
`scripts/verify-capability-seams.ts`
等门禁检查，`scripts/module-test-metadata.ts` 用它解析 `test:domain` 目标。

## Goals / Non-Goals

**Goals:**

- 新增一个普通功能（含表、路由、一个后台任务、测试）时，改动文件 ≤ 6
  个，且不触碰任何手工登记表。
- AI 编码助手修改某功能时，只需阅读该功能目录与 `shared/` 的相关文件。
- 依赖规则少而明确，违规时检查脚本给出可直接执行的修复提示。
- 全程集成分支（当前为 `rc/v0.11`）可部署、API 与行为不变、测试全绿。

**Non-Goals:**

- 不重构 noj-ui、noj-judge、noj-llm-gateway、noj-cli 的结构，不改顶层模块名字。
- 不修改数据库表结构与迁移历史；不改 API 路径、响应或业务语义。
- 不追求在固定期限内迁完全部旧模块。
- 不引入新的运行时框架或 DI 容器。

## Decisions

### 1. 目标结构：`shared/` + `features/`

> 底座目录沿用现有 `shared/`，不改名为 `kernel/`（2026-11-11 决定：改名需改 789
> 个文件、2283 行 import，收益只是名称）。下文「底座」均指 `shared/`。

```text
noj-core/src/
├── shared/                 # 底座：db、mq、http、config、errors、auth/actor、tasks 运行时、
│                           # observability、storage、sse、rate-limit、llm 客户端
├── features/
│   └── <name>/
│       ├── index.ts        # 唯一对外出口：export const feature = defineFeature({...}) + 公开函数/类型
│       ├── routes.ts       # 可拆为 routes/*.ts
│       ├── service.ts      # 可拆为多个 *.ts，按需而非按层
│       ├── *_test.ts
│       └── README.md       # 一屏以内：职责、关键约束、对外函数
├── features.ts             # 功能清单，一行一个
├── app.ts                  # createApp：中间件 + 遍历 features 挂载路由
└── main.ts                 # 启动：底座初始化 + 遍历 features 启动任务与 worker
```

表定义保留在 `shared/db/schema/`（2026-11-11 阶段 3
决定）：表常被其他功能外键引用、迁移统一生成，且把表放进功能目录会让底座反向依赖功能。

功能内部**不强制分层**：小功能一个 `service.ts` 即可，大功能按子主题拆文件。
`contracts/ types/ services/` 这类按层目录不再作为约定。

备选：保留现有模块，只删合同层。放弃原因：编排层与登记表仍在，「新增功能要改很多处」的根因不变。

### 2. 功能自声明与清单装配

```ts
// features/trainings/index.ts
export const feature = defineFeature({
  name: "trainings",
  routes: (app) => {
    app.route("/d/:domain/trainings", trainingsRouter);
  },
  tasks: { "trainings.recompute": handleRecompute },
  workers: [],
  observability: (registry) => {},
});
export { lockTrainingExpansion, readDomainTraining } from "./service.ts";
```

```ts
// features.ts
export const FEATURES = [
  accounts.feature,
  workspaces.feature,
  problems.feature,
  trainings.feature,
  // …
] as const;
```

- `createApp` 遍历 `FEATURES` 挂载路由与观测；`main` 遍历启动 worker
  并汇总任务处理器。
- 任务类型由各功能 `tasks` 的键推导，`runtime/tasks`
  启动时校验无重名，取代集中的 `TASK_TYPES`。
- 路由挂载顺序、中间件顺序与现状逐项对齐，由现有路由测试保证行为不变。

### 3. 依赖规则（替代现有边界门禁）

1. `features/A/**` 只能 import
   `shared/**`、`features/A/**`、`features/B/index.ts`；
2. `shared/**` 不得 import `features/**`；
3. 功能之间的 import 图不得有环。

新脚本 `scripts/check-feature-boundaries.ts` 约 100 行，基于 import
静态扫描；违规时输出 「将 `features/B/service.ts` 改为从 `features/B/index.ts`
引入，并在其中导出 `xxx`」。

跨功能的连带操作（如删除题目时删除评测记录）由调用方直接调用对方 `index.ts`
导出的函数， 在同一事务中显式完成，不引入事件总线或回调注册。

### 4. 测试识别

`test:domain <name>` 解析为
`features/<name>/`；迁移期间对尚未迁移的旧模块保留现有映射，
`module-test-metadata.ts` 仅为旧模块服务，随最后一个旧模块迁出一并删除。 CI
的按路径选择测试同样按 `features/<name>/` 自动推导。

### 5. 初始功能划分（草案，迁移时按实际调整）

| feature                                        | 主要来源                                                      |
| ---------------------------------------------- | ------------------------------------------------------------- |
| `accounts`                                     | access/identity、access/account                               |
| `workspaces`                                   | access/workspace、domains、members、invitations、registration |
| `problems`                                     | problems/problems、versioning、oi-*、bundle、support-package  |
| `objective`                                    | problems/objective、evaluations/objective                     |
| `tags` / `trainings`                           | problems/tags、trainings、workspace/trainings                 |
| `submissions`                                  | evaluations/submissions、queue、mq、self-tests、versioning    |
| `contests`                                     | contests/*                                                    |
| `classrooms` / `assignments`                   | education/*                                                   |
| `community` / `notifications`                  | communication/*                                               |
| `search` / `stats`                             | read-models/search、read-models/queries                       |
| `announcements` / `legal` / `settings` / `llm` | platform/*                                                    |
| `storage-governance`                           | assets/*（存储适配器本身进入 shared）                         |

底座
`shared/`（即提案中的「kernel」，**保留原目录名不改名**）后续需迁入：`runtime/tasks`、`platform/observability`
基础设施、 `assets/storage` 适配器、`platform/gateway`
客户端、系统设置读取、actor/capability 解析。

### 6. 门禁精简原则

- **保留**（防事故）：迁移安全、迁移快照链、依赖审计、Action
  版本锁定、写入限流、上传限制、
  生产环境变量注入、测试可发现性、静默跳过棘轮、版本一致性、fmt/lint/类型检查。
- **替换**：模块边界、合同转出、capability seams → 新的
  `check-feature-boundaries.ts`。
- **删除**：已空转的门禁（如 `check-domains.ts`）；迁移完成后失去对象的门禁（如
  legacy API 移除检查）。
- **降级为生成**：路由目录、事件目录改为按需生成，不作为 CI 失败条件。
- **单独评估**：导出 JSDoc 覆盖率、日志迁移检查、Agent Note
  格式检查——逐项写明它防什么， 能说清实际防住过的问题才保留。

每删除一项门禁，在对应 PR 描述中写明删除理由与替代保障。

### 7. 文档

- 根 `AGENTS.md` 与 `noj-core/AGENTS.md` 改写为：结构图、三条规则、「新功能照
  `features/trainings` 写」、 命令清单；目标单文件不超过 200 行。
- `dev-docs/engineering/` 中描述旧模块边界的文档在对应结构删除时一并删除或归档。
- Agent Note 仅用于架构级决策；本变更本身写一条。

## Risks / Trade-offs

- **机械搬迁与并行分支冲突** → 搬迁用脚本（复用
  `scripts/rewrite-imports.ts`）一次完成，单独 PR，
  提前与其他开发者约定合入窗口；业务改动不与搬迁混在同一 PR。
- **测试漏跑** → 阶段 2 先完成测试识别切换，并比对切换前后各 domain
  发现的测试文件集合一致。
- **路由/中间件顺序变化导致行为差异** → 清单装配首个 PR
  只改装配方式不改顺序，路由快照比对前后一致。
- **新结构不合适** → 阶段 3 用题单迁移试点，按 6
  文件指标验收；不达标先调结构，不继续迁移。
- **新旧并存期认知负担** → 根 `AGENTS.md` 明确「新功能一律进
  `features/`；改旧模块时顺手迁移」。

## Migration Plan

1. **阶段 0
   对齐**：本提案评审定稿；记录基线（新增一个普通功能需改动的文件清单）。
2. **阶段 1 先砍开销，不搬代码**：合并跨模块转出为模块级出口；按第 6
   节精简门禁；精简 AGENTS.md。
3. **阶段 2 骨架**：引入 `defineFeature`、`features.ts`、清单装配
   （与旧装配并存）；新边界脚本与测试识别上线。
4. **阶段 3 试点**：题单迁入 `features/trainings/`，删除其在
   `application/`、合同层与登记表中的残留； 按指标验收后定为官方样例。
5. **阶段 4 按需迁移**：其余模块「改到即迁」；最后一个旧模块迁出后删除
   `modules/`、`application/`、
   `module-boundaries.json`、`module-test-metadata.ts`。
6. **阶段 5 接口类型**：core 与 noj-ui 共享接口类型（Hono RPC 类型或 schema
   生成，届时单独决策）， 逐步替换 ui 手写类型。

回滚：每个阶段均为独立 PR，可按 PR 回退；阶段 2
起新旧装配并存，回退不影响已迁功能之外的代码。

## Open Questions

- 阶段 5 采用 Hono RPC 类型推导还是 schema
  生成？前者零生成步骤但要求路由链式定义，后者对现有路由侵入小。
- `objective` 是否独立成功能，还是并入 `problems` / `submissions`？以阶段 4
  实际耦合度决定。
- Agent Note 的保留范围：仅架构决策，还是彻底改为写在 PR 描述中？
