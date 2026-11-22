# 代码结构与功能切片（noj-core）

> 目标形态是 `shared/` + `features/<name>/` 两层；方案与分阶段计划以
> [`../../dev-docs/refactor/core-feature-slices/`](../../dev-docs/refactor/core-feature-slices/)
> 的 `proposal.md` / `design.md` 为准。旧 `modules/`（含 `application/` 编排层）
> 仍在，原则是「改到即迁」，不要为了迁移而迁移。

## 1. 切片规则

- 一个功能一个目录：`src/features/<name>/`。
- `index.ts` 是唯一对外出口；目录内部文件可以互相引用，目录外只能从 `index.ts`
  取能力。
- 新功能禁止写进 `modules/`；旧模块只在本次改动涉及的文件上迁移。
- 跨功能禁止深引用：只能 import 对方的 `index.ts`。
- `shared/` 是跨功能底座，**不得反向依赖** `features/`。
- 功能引用旧模块时，只能走该模块的 `index.ts` 或 `contracts/`。
- 功能之间的运行时 import 不得成环。
- 以上规则由仓库根的
  [`../../scripts/check-feature-boundaries.ts`](../../scripts/check-feature-boundaries.ts)
  检查。

## 2. defineFeature 装配

```ts
// src/features/trainings/index.ts（样例）
import { defineFeature } from "../../shared/feature.ts";
import { domainTrainingsRouter } from "./routes.ts";

export const feature = defineFeature({
    // 小写 kebab-case，必须等于目录名，也是 test:domain 的目标名
    name: "trainings",
    // 挂到 /api/v1 下；具体路径在 router 内部声明
    router: domainTrainingsRouter,
    // tasks?: 后台任务处理器，key 必须以 "<name>." 开头
    // workers?: 返回 ManagedTask 的常驻 worker 启动函数
    // observability?: 指标 / 健康探针注册回调
});
```

`defineFeature`（`src/shared/feature.ts`）在模块加载期校验并冻结声明：

- `name` 非法直接抛错；任务类型不以 `<name>.` 开头也抛错。
- `tasks` 不得与内置任务或其他功能重复；冲突时启动失败，不允许后者静默覆盖。
- 路由、后台任务、worker 与观测点都由该声明描述，不要在其他位置重复注册。

## 3. 功能清单

1. 在 `src/features.ts` 的 `FEATURES` 数组加一行，例如 `trainings.feature`。
2. `createApp` 与启动流程遍历清单，自动完成路由、任务、worker 和观测装配。
3. `src/main.ts` 只调用启动入口，不在这里手工注册功能。
4. 样例目录：[`src/features/trainings/`](../src/features/trainings/)。

## 4. 路由与错误

- 路由文件默认导出 Hono 实例，由 `src/app.ts` 组合；统一挂载在
  `/api/v1/{resource}`。`src/app.ts` 是应用工厂，`src/mod.ts` 是公共导出。
- 错误统一使用 `AppError` 继承体系；全局 `onError` 捕获并带回 `request_id`。
- 鉴权守卫的选择见 [`access.md`](./access.md)；不要在路由里另造错误响应格式。

## 5. 新功能落地顺序

1. 建 `src/features/<name>/`：`index.ts`、`routes.ts`、`service.ts` 与测试。
2. 在 `index.ts` 用 `defineFeature` 暴露路由 / 任务 / worker / 观测点。
3. 在 `src/features.ts` 加一行。
4. 跑 `deno task check` 与 `deno task test:domain <name>`。
