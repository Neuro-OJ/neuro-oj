## Why

noj-core 当前按「大团队长期协作」标准搭建：12 个业务/基础模块，外加
`application` 编排层、
跨模块合同层与多道架构治理门禁。实际开发方式是一到两名开发者配合 AI 编码助手，
治理成本已明显超过它防住的风险：

- 一个写请求要经过「路由 → `application/X.ts` → `modules/X/services` → 他模块
  `contracts/cross-module/*.ts`」四跳；`application/problems.ts` 557 行、
  `application/evaluations.ts` 621 行，大部分是转发与装配。
- 合同文件 76 个，其中跨模块转出文件 66 个，许多只转出一两个函数。
- 模块边界靠 `check-module-boundaries.ts`（933 行）+
  `module-boundaries.json`（535 行）维护； 该 JSON 同时被测试启动器用来解析
  `test:domain` 路径，改目录就要改登记。
- 部分门禁已经空转：`check-domains.ts` 仍扫描早已不存在的 `src/domains/`。
- `create-app.ts` 手工导入约 30 个路由，`create-system.ts`（507
  行）手工启动各后台进程， `TASK_TYPES` 集中登记任务类型。
- 以「题单」为例，一个中等功能分散在约 30 个文件中。

结果是新增一个功能需要触碰十几处与功能本身无关的位置；AI
编码助手每多一层跳转就多一次读取与
上下文占用，也更容易「改了这里、漏了那里」。在启动知识图谱
（`openspec/changes/add-knowledge-graph`）等新核心功能之前，先把「新增功能」这条路径变轻。

## What Changes

- noj-core 源码收敛为 **`shared/` + `features/`** 两层：
  - `shared/`：所有功能共用、很少变化的底座（由 `shared/`
    及运行时、观测、存储、配置、鉴权基础迁入）；
  - `features/<name>/`：一个功能的路由、服务、测试与简短说明放在同一目录（表定义仍在
    `shared/db/schema/`）， 只通过 `index.ts` 对外暴露。
- 每个功能在 `index.ts` 中用 `defineFeature()` **自声明**路由、后台任务、常驻
  worker 与观测注册； `features.ts` 为一行一个功能的清单，`createApp` /
  `create-system` 遍历清单装配。
- 依赖规则收敛为三条，由一个新的小型检查脚本强制：功能只能引用 `shared/`
  与其他功能的 `index.ts`；`shared/` 不得引用功能；功能间不得循环依赖。
- `test:domain` 改为按 `features/<name>/` 目录自动识别，不再依赖手工登记。
- 逐步删除：`application/`
  编排层、跨模块合同转出文件、`module-boundaries.json`、
  与新规则重复或已空转的治理门禁。
- 精简 `AGENTS.md`（根目录与 noj-core）：只保留规则与「照此样例写」的指引。
- 本变更所有 PR 以 `rc/v0.11` 为目标分支（当前实际开发线，领先
  `main`）；新旧结构并存期间该分支
  始终可部署；旧模块按「改到即迁」原则迁移，不做一次性大搬迁。

**不变**：noj-ui / noj-judge / noj-llm-gateway / noj-cli
的结构与名字；数据库表结构； 任何 API
与业务行为；迁移安全、安全类、依赖审计等防事故门禁。

## Capabilities

### New Capabilities

- `core-architecture`: noj-core 的代码组织、依赖规则、功能装配与测试识别约定。

### Modified Capabilities

<!-- 不修改任何业务能力；对外 API 与行为保持不变。 -->

## Impact

- 影响 noj-core 全部源码路径（分阶段）、测试启动器、CI 门禁清单与工程文档。
- 进行中的分支在机械改名阶段会产生冲突：机械改动一律脚本化、单独成
  PR，并与其他开发者约定合入窗口。
- 知识图谱等新功能在本变更阶段 2 完成后直接按 `features/` 结构实现。
- noj-ui 仅在阶段 5 受影响（接入 core 接口类型），目录结构不在本变更范围。
