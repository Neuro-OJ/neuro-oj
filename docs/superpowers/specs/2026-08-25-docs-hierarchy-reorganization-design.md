# Neuro OJ 文档层级重构设计

- 日期：2026-08-25
- 状态：已与需求方确认，待用户审阅
- 范围：noj-docs 文档站信息架构重构，无代码/数据库变更

## 背景

当前 noj-docs 按角色分为 `intro / users / operators / problemsetters / reference`，存在以下问题：

- 出题人区过于拥挤：实操、规范、SDK 进阶混在一起。
- “题目规范及质量要求”放在出题人区，但审核者/运营者也需阅读，位置不够通用。
- 角色边界模糊，部分内容不知道放哪。
- 缺少总览导航。
- 存在旧页面重定向、重复内容、链接不一致。

## 目标

- 将文档站重构为“面向角色实操教程 + 面向主题文档”双区结构。
- 把规范性文档从角色章节移到系统性主题章节。
- 角色章节只保留实操向教程。
- 提供全局侧边栏总览导航。
- 清理旧路径重定向与链接。

## 非目标

- 不改动 noj-core / noj-judge / noj-ui 代码。
- 不新增功能页面内容（除必要的章节 index 与 system 架构/安全/存储主题页）。
- 不处理 OpenSpec 规范内容本身，只调整文档站层级。

## 关键决策

1. **双区结构**：顶层分为“快速开始 / 面向角色 / 面向主题”。
2. **规范提升为顶层**：`standards/` 作为面向主题下的独立章节。
3. **全局侧边栏**：所有页面共用同一套导航，体现完整层级。
4. **旧路径重定向**：被移动页面在旧路径保留短重定向页。

## 设计内容

### 1. 顶层信息架构

```text
noj-docs/docs/
├── intro/          # 快速开始（入门）
├── users/          # 面向角色：做题人（实操）
├── problemsetters/ # 面向角色：出题人（实操）
├── operators/      # 面向角色：运营者（实操）
├── standards/      # 系统性：题目规范及质量要求
├── mechanisms/     # 系统性：评测机制与 SDK
├── system/         # 系统性：系统架构与运维主题
├── features/       # 系统性：功能主题
└── reference/      # 系统性：参考
```

### 2. 页面迁移映射

| 当前路径 | 目标路径 | 说明 |
|---|---|---|
| `problemsetters/standards/*` | `standards/*` | 题目规范及质量要求提升为顶层 |
| `problemsetters/judge-model.md` | `mechanisms/judge-model.md` | 评测模型属机制 |
| `problemsetters/evaluator-sdk.md` | `mechanisms/evaluator-sdk.md` | SDK 属机制 |
| `problemsetters/solution-sdk.md` | `mechanisms/solution-sdk.md` | SDK 属机制 |
| `problemsetters/rpc.md` | `mechanisms/rpc.md` | RPC 属机制 |
| `problemsetters/runtimes.md` | `mechanisms/runtimes.md` | 运行时属机制 |
| `problemsetters/capability-networking.md` | `mechanisms/capability-networking.md` | 网络能力属机制 |
| `operators/storage.md` | `system/storage.md` | 存储主题移入系统章节 |
| `users/ranking.md` | `features/ranking.md` | 功能主题 |
| `users/search-messages.md` | `features/search-messages.md` | 功能主题 |
| `problemsetters/support-package.md` | 重定向到 `standards/problem-bundle.md` | 旧重定向 |
| `problemsetters/cases.md` | 重定向到 `standards/test-data.md` | 旧重定向 |

### 3. 各章节内容

#### 快速开始（`intro/`）
- `index.md`（总览/导航）
- `what-is-noj.md`
- `getting-started.md`
- `faq.md`

#### 面向角色：做题人（`users/`）
- `index.md`
- `submit.md`
- `capability.md`
- `results.md`
- `account.md`
- `ranking.md`、`search-messages.md` 移入 `features/`

#### 面向角色：出题人（`problemsetters/`）
- `index.md`
- `quick-start.md`
- `web-editor.md`
- `ab-example.md`
- `llm-problem.md`
- `judge-model.md`、`evaluator-sdk.md`、`solution-sdk.md`、`rpc.md`、`runtimes.md`、`capability-networking.md` 移入 `mechanisms/`
- `standards/` 整体移入顶层 `standards/`
- `support-package.md`、`cases.md` 重定向到 `standards/` 对应页

#### 面向角色：运营者（`operators/`）
- `index.md`
- `admin-guide.md`
- `cli.md`
- `judge-workers.md`
- `llm-call-capability.md`
- `production-deploy.md`
- `production-secrets.md`
- `storage.md` 移入 `system/storage.md`，原页重定向

#### 系统性：题目规范及质量要求（`standards/`）
- `index.md`
- `problem-bundle.md`
- `test-data.md`
- `quality.md`

#### 系统性：评测机制与 SDK（`mechanisms/`）
- `index.md`（新增总览）
- `judge-model.md`
- `evaluator-sdk.md`
- `solution-sdk.md`
- `rpc.md`
- `runtimes.md`
- `capability-networking.md`

#### 系统性：系统架构与运维主题（`system/`）
- `index.md`（新增总览）
- `architecture.md`（新增：系统架构总览）
- `security.md`（新增：安全模型）
- `storage.md`（从 `operators/storage.md` 移入并增强）

#### 系统性：功能主题（`features/`）
- `index.md`（新增总览）
- `ranking.md`（从 `users/ranking.md` 移入）
- `search-messages.md`（从 `users/search-messages.md` 移入）

#### 系统性：参考（`reference/`）
- `index.md`
- `glossary.md`
- `result-status.md`
- `changelog.md`

### 4. 导航策略

改为全局侧边栏，所有页面共用：

```ts
sidebar: {
  "/": [
    { text: "快速开始", items: [...] },
    {
      text: "面向角色",
      collapsed: true,
      items: [
        { text: "做题人", items: [...] },
        { text: "出题人", items: [...] },
        { text: "运营者", items: [...] },
      ],
    },
    {
      text: "面向主题",
      collapsed: true,
      items: [
        { text: "题目规范及质量要求", items: [...] },
        { text: "评测机制与 SDK", items: [...] },
        { text: "系统架构与运维主题", items: [...] },
        { text: "功能主题", items: [...] },
        { text: "参考", items: [...] },
      ],
    },
  ],
}
```

### 5. 重定向策略

- 被移动的旧路径创建短重定向页，指向新路径。
- 旧 `support-package.md` / `cases.md` 继续指向 `standards/` 对应页。
- `operators/storage.md` 指向 `system/storage.md`。
- `users/ranking.md`、`users/search-messages.md` 指向 `features/` 对应页。

### 6. 验证

- `grep` 检查旧路径引用是否清理干净。
- `npm run docs:build` 确认构建成功、无死链。
- 人工检查侧边栏层级与页面归属。

## 后续流程

- 本设计文档经用户审阅后，进入 `writing-plans` 制定实施计划。
- 实施时按“移动文件 → 更新链接 → 新增 index/主题页 → 改全局侧边栏 → 验证”的顺序推进。
