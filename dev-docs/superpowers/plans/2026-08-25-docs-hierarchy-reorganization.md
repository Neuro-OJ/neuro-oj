# Neuro OJ 文档层级重构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 noj-docs 重构为“快速开始 / 面向角色 / 面向主题”双区结构，并把题目规范、评测机制、系统主题、功能主题从角色章节中分离出来。

**Architecture:** 纯文档站信息架构调整。移动现有 Markdown 文件到新目录，新增 `mechanisms/`、`system/`、`features/` 章节与 index 页，新增 `system/architecture.md`、`system/security.md`，将 VitePress 侧边栏改为全局侧边栏，旧路径保留短重定向页。

**Tech Stack:** Markdown、VitePress、jj（VCS 由用户处理）。

**Spec:** `dev-docs/superpowers/specs/2026-08-25-docs-hierarchy-reorganization-design.md`

## Global Constraints

- 不改动 noj-core / noj-judge / noj-ui 代码。
- 不新增功能页面内容（除章节 index 与 system 架构/安全/存储主题页）。
- 文档语言为中文；文件名/目录名使用英文。
- VCS 操作由用户处理，计划中不包含提交步骤。
- 所有旧路径必须保留短重定向页，避免死链。

---

### Task 1: 创建新章节目录与 index 页

**Files:**
- Create: `noj-docs/docs/mechanisms/index.md`
- Create: `noj-docs/docs/system/index.md`
- Create: `noj-docs/docs/features/index.md`
- Create: `noj-docs/docs/standards/index.md`（从 `problemsetters/standards/index.md` 移入）

**Interfaces:**
- Consumes: 设计文档第 3 节页面清单
- Produces: 新章节目录骨架，后续 Task 2–4 移入页面

- [ ] **Step 1: 创建目录**

```bash
mkdir -p noj-docs/docs/mechanisms noj-docs/docs/system noj-docs/docs/features noj-docs/docs/standards
```

- [ ] **Step 2: 移动 `standards/` 到顶层**

```bash
mv noj-docs/docs/problemsetters/standards/* noj-docs/docs/standards/
rmdir noj-docs/docs/problemsetters/standards
```

- [ ] **Step 3: 创建 `mechanisms/index.md`**

内容：

```markdown
# 评测机制与 SDK

本部分介绍 Neuro OJ 的评测机制、双容器模型、Evaluator/Solution SDK、RPC 与运行时。

- [评测模型](judge-model.md)
- [Evaluator SDK](evaluator-sdk.md)
- [Solution SDK](solution-sdk.md)
- [RPC 与可传递数据](rpc.md)
- [评测镜像与运行时](runtimes.md)
- [如何提供受限网络能力](capability-networking.md)
```

- [ ] **Step 4: 创建 `system/index.md`**

内容：

```markdown
# 系统架构与运维主题

本部分介绍 Neuro OJ 的系统架构、安全模型与存储交付。

- [系统架构](architecture.md)
- [安全模型](security.md)
- [存储与评测包交付](storage.md)
```

- [ ] **Step 5: 创建 `features/index.md`**

内容：

```markdown
# 功能主题

本部分按功能维度介绍 Neuro OJ 的各类功能。

- [排行榜与签到](ranking.md)
- [搜索与私信](search-messages.md)
```

- [ ] **Step 6: 确认 `standards/index.md` 已存在且内容正确**

读取 `noj-docs/docs/standards/index.md`，应包含“题目规范及质量要求”总览与三个子页链接。

---

### Task 2: 移动评测机制页面到 `mechanisms/`

**Files:**
- Move: `noj-docs/docs/problemsetters/judge-model.md` → `noj-docs/docs/mechanisms/judge-model.md`
- Move: `noj-docs/docs/problemsetters/evaluator-sdk.md` → `noj-docs/docs/mechanisms/evaluator-sdk.md`
- Move: `noj-docs/docs/problemsetters/solution-sdk.md` → `noj-docs/docs/mechanisms/solution-sdk.md`
- Move: `noj-docs/docs/problemsetters/rpc.md` → `noj-docs/docs/mechanisms/rpc.md`
- Move: `noj-docs/docs/problemsetters/runtimes.md` → `noj-docs/docs/mechanisms/runtimes.md`
- Move: `noj-docs/docs/problemsetters/capability-networking.md` → `noj-docs/docs/mechanisms/capability-networking.md`

**Interfaces:**
- Consumes: Task 1 创建的 `mechanisms/` 目录
- Produces: `mechanisms/` 下完整页面，Task 7 更新链接

- [ ] **Step 1: 移动文件**

```bash
mv noj-docs/docs/problemsetters/judge-model.md noj-docs/docs/mechanisms/judge-model.md
mv noj-docs/docs/problemsetters/evaluator-sdk.md noj-docs/docs/mechanisms/evaluator-sdk.md
mv noj-docs/docs/problemsetters/solution-sdk.md noj-docs/docs/mechanisms/solution-sdk.md
mv noj-docs/docs/problemsetters/rpc.md noj-docs/docs/mechanisms/rpc.md
mv noj-docs/docs/problemsetters/runtimes.md noj-docs/docs/mechanisms/runtimes.md
mv noj-docs/docs/problemsetters/capability-networking.md noj-docs/docs/mechanisms/capability-networking.md
```

- [ ] **Step 2: 检查移动后文件内相对链接**

运行：

```bash
grep -n "\.\./\|problemsetters/" noj-docs/docs/mechanisms/*.md
```

记录需要修正的链接，交给 Task 7 统一处理。

---

### Task 3: 移动存储页并新增系统主题页

**Files:**
- Move: `noj-docs/docs/operators/storage.md` → `noj-docs/docs/system/storage.md`
- Create: `noj-docs/docs/system/architecture.md`
- Create: `noj-docs/docs/system/security.md`

**Interfaces:**
- Consumes: Task 1 创建的 `system/` 目录
- Produces: `system/` 下完整页面，Task 7 更新链接

- [ ] **Step 1: 移动 `storage.md`**

```bash
mv noj-docs/docs/operators/storage.md noj-docs/docs/system/storage.md
```

- [ ] **Step 2: 创建 `architecture.md`**

内容（基于 AGENTS.md 第 1 节精简）：

```markdown
# 系统架构

Neuro OJ 由三个核心模块组成，通过 RESTful API 和 Redis 消息队列协作：

- **noj-core**：Deno + Hono，提供 RESTful API、JWT 鉴权 + RBAC、题目/提交/竞赛/社区 CRUD、Redis MQ Producer/Consumer。
- **noj-ui**：Nuxt 4 + Vue 3，Web 前端，Nitro 反向代理注入 JWT Cookie。
- **noj-judge**：Rust + Tokio，Docker 沙箱评测，双容器架构（Evaluator + Solution）。

基础设施：PostgreSQL 16（持久化）+ Redis 7（MQ + 缓存）。

详细模块职责见仓库根目录 `AGENTS.md`。
```

- [ ] **Step 3: 创建 `security.md`**

内容（基于 AGENTS.md 第 11 节精简）：

```markdown
# 安全模型

- 认证：JWT HS256，HTTP-only Cookie，24h 过期。
- 密码：bcrypt cost 12，最小 8 位含大小写与数字。
- 容器安全：cap_drop ALL、no-new-privileges、network_mode none、ipc_mode none、pids_limit 256。
- ZIP 安全：拒绝路径穿越、条目数 ≤ 1000、单文件 ≤ 64 MiB、总解压 ≤ 512 MiB。
- 日志安全：生产环境 UUID 截断、score 隐藏、DB 密码脱敏。

详细安全模型见仓库根目录 `AGENTS.md`。
```

- [ ] **Step 4: 检查 `system/storage.md` 内相对链接**

运行：

```bash
grep -n "\.\./\|operators/" noj-docs/docs/system/storage.md
```

记录需要修正的链接，交给 Task 7 统一处理。

---

### Task 4: 移动功能主题页面到 `features/`

**Files:**
- Move: `noj-docs/docs/users/ranking.md` → `noj-docs/docs/features/ranking.md`
- Move: `noj-docs/docs/users/search-messages.md` → `noj-docs/docs/features/search-messages.md`

**Interfaces:**
- Consumes: Task 1 创建的 `features/` 目录
- Produces: `features/` 下完整页面，Task 7 更新链接

- [ ] **Step 1: 移动文件**

```bash
mv noj-docs/docs/users/ranking.md noj-docs/docs/features/ranking.md
mv noj-docs/docs/users/search-messages.md noj-docs/docs/features/search-messages.md
```

- [ ] **Step 2: 检查移动后文件内相对链接**

运行：

```bash
grep -n "\.\./\|users/" noj-docs/docs/features/*.md
```

记录需要修正的链接，交给 Task 7 统一处理。

---

### Task 5: 更新角色章节 index 与内容

**Files:**
- Modify: `noj-docs/docs/users/index.md`
- Modify: `noj-docs/docs/problemsetters/index.md`
- Modify: `noj-docs/docs/operators/index.md`

**Interfaces:**
- Consumes: Task 2–4 的移动结果
- Produces: 角色章节只保留实操内容，并链接到系统性章节

- [ ] **Step 1: 更新 `users/index.md`**

移除 `ranking.md`、`search-messages.md` 条目，改为：

```markdown
- 排行榜与签到、搜索与私信见[功能主题](../features/)。
```

- [ ] **Step 2: 更新 `problemsetters/index.md`**

移除 `judge-model`、`evaluator-sdk`、`solution-sdk`、`rpc`、`runtimes`、`capability-networking`、`standards` 相关条目，改为：

```markdown
- 评测机制与 SDK 见[评测机制与 SDK](../mechanisms/)。
- 题目规范及质量要求见[题目规范及质量要求](../standards/)。
```

- [ ] **Step 3: 更新 `operators/index.md`**

移除 `storage.md` 条目，改为：

```markdown
- 存储与评测包交付见[系统架构与运维主题](../system/storage.md)。
```

---

### Task 6: 重写 VitePress 为全局侧边栏

**Files:**
- Modify: `noj-docs/docs/.vitepress/config.ts`

**Interfaces:**
- Consumes: Task 1–5 的目录与页面
- Produces: 全局侧边栏，体现双区结构

- [ ] **Step 1: 替换 `sidebar` 配置**

将 `config.ts` 中整个 `sidebar` 对象替换为：

```ts
sidebar: {
  "/": [
    {
      text: "快速开始",
      items: [
        { text: "什么是 Neuro OJ", link: "/intro/what-is-noj" },
        { text: "快速开始", link: "/intro/getting-started" },
        { text: "常见问题", link: "/intro/faq" },
      ],
    },
    {
      text: "面向角色",
      collapsed: true,
      items: [
        {
          text: "做题人",
          items: [
            { text: "做题人文档", link: "/users/" },
            { text: "提交代码", link: "/users/submit" },
            { text: "使用 capability", link: "/users/capability" },
            { text: "理解结果", link: "/users/results" },
            { text: "账号与密码", link: "/users/account" },
          ],
        },
        {
          text: "出题人",
          items: [
            { text: "出题人文档", link: "/problemsetters/" },
            { text: "快速出一题", link: "/problemsetters/quick-start" },
            { text: "Web 题目编辑器", link: "/problemsetters/web-editor" },
            { text: "A+B 示例题", link: "/problemsetters/ab-example" },
            { text: "出 LLM 调用题", link: "/problemsetters/llm-problem" },
          ],
        },
        {
          text: "运营者",
          items: [
            { text: "运营者文档", link: "/operators/" },
            { text: "生产部署", link: "/operators/production-deploy" },
            { text: "如何提供 LLM 调用能力", link: "/operators/llm-call-capability" },
            { text: "CLI 初始化", link: "/operators/cli" },
            { text: "Judge Worker 运维", link: "/operators/judge-workers" },
            { text: "后台管理指南", link: "/operators/admin-guide" },
            { text: "生产密钥", link: "/operators/production-secrets" },
          ],
        },
      ],
    },
    {
      text: "面向主题",
      collapsed: true,
      items: [
        {
          text: "题目规范及质量要求",
          items: [
            { text: "总览", link: "/standards/" },
            { text: "题目包格式规范", link: "/standards/problem-bundle" },
            { text: "测试数据与样例规范", link: "/standards/test-data" },
            { text: "题目质量要求", link: "/standards/quality" },
          ],
        },
        {
          text: "评测机制与 SDK",
          items: [
            { text: "总览", link: "/mechanisms/" },
            { text: "评测模型", link: "/mechanisms/judge-model" },
            { text: "Evaluator SDK", link: "/mechanisms/evaluator-sdk" },
            { text: "Solution SDK", link: "/mechanisms/solution-sdk" },
            { text: "RPC 与可传递数据", link: "/mechanisms/rpc" },
            { text: "评测镜像与运行时", link: "/mechanisms/runtimes" },
            { text: "如何提供受限网络能力", link: "/mechanisms/capability-networking" },
          ],
        },
        {
          text: "系统架构与运维主题",
          items: [
            { text: "总览", link: "/system/" },
            { text: "系统架构", link: "/system/architecture" },
            { text: "安全模型", link: "/system/security" },
            { text: "存储与评测包交付", link: "/system/storage" },
          ],
        },
        {
          text: "功能主题",
          items: [
            { text: "总览", link: "/features/" },
            { text: "排行榜与签到", link: "/features/ranking" },
            { text: "搜索与私信", link: "/features/search-messages" },
          ],
        },
        {
          text: "参考",
          items: [
            { text: "参考文档", link: "/reference/" },
            { text: "术语表", link: "/reference/glossary" },
            { text: "结果状态", link: "/reference/result-status" },
            { text: "更新日志", link: "/reference/changelog" },
          ],
        },
      ],
    },
  ],
},
```

- [ ] **Step 2: 检查 `config.ts` 语法**

运行：

```bash
cd noj-docs && npx vitepress build docs
```

预期：构建成功（此步同时验证后续链接）。

---

### Task 7: 创建旧路径重定向页并更新内部链接

**Files:**
- Create/Modify redirect stubs:
  - `noj-docs/docs/problemsetters/judge-model.md`
  - `noj-docs/docs/problemsetters/evaluator-sdk.md`
  - `noj-docs/docs/problemsetters/solution-sdk.md`
  - `noj-docs/docs/problemsetters/rpc.md`
  - `noj-docs/docs/problemsetters/runtimes.md`
  - `noj-docs/docs/problemsetters/capability-networking.md`
  - `noj-docs/docs/operators/storage.md`
  - `noj-docs/docs/users/ranking.md`
  - `noj-docs/docs/users/search-messages.md`
- Modify: 所有仍指向旧路径的 Markdown 文件

**Interfaces:**
- Consumes: Task 2–4 移动结果
- Produces: 无死链，旧链接可跳转

- [ ] **Step 1: 为每个被移动页面创建短重定向页**

示例（`problemsetters/judge-model.md`）：

```markdown
# 评测模型

> 本文档已迁移至 [评测机制与 SDK](../mechanisms/judge-model.md)。
```

按同样模式创建其余重定向页，目标路径分别为：

| 旧路径 | 新路径 |
|---|---|
| `problemsetters/evaluator-sdk.md` | `../mechanisms/evaluator-sdk.md` |
| `problemsetters/solution-sdk.md` | `../mechanisms/solution-sdk.md` |
| `problemsetters/rpc.md` | `../mechanisms/rpc.md` |
| `problemsetters/runtimes.md` | `../mechanisms/runtimes.md` |
| `problemsetters/capability-networking.md` | `../mechanisms/capability-networking.md` |
| `operators/storage.md` | `../system/storage.md` |
| `users/ranking.md` | `../features/ranking.md` |
| `users/search-messages.md` | `../features/search-messages.md` |

- [ ] **Step 2: 更新所有指向旧路径的链接**

运行：

```bash
grep -rn "problemsetters/judge-model\|problemsetters/evaluator-sdk\|problemsetters/solution-sdk\|problemsetters/rpc\|problemsetters/runtimes\|problemsetters/capability-networking\|operators/storage\|users/ranking\|users/search-messages" noj-docs/docs --include='*.md' --include='*.ts'
```

逐一把命中链接改为新路径（注意相对路径层级）。

- [ ] **Step 3: 更新 `problemsetters/support-package.md` / `cases.md` 重定向**

确认它们指向 `../standards/problem-bundle.md` 与 `../standards/test-data.md`（若已正确则跳过）。

- [ ] **Step 4: 更新 `problemsetters/index.md`、`users/index.md`、`operators/index.md` 中的链接**

确保指向 `../mechanisms/`、`../standards/`、`../features/`、`../system/` 等新路径。

---

### Task 8: 验证

**Files:**
- 无新增文件；运行验证命令

**Interfaces:**
- Consumes: Task 1–7 全部产物
- Produces: 验证通过结论

- [ ] **Step 1: grep 检查旧路径残留**

运行：

```bash
grep -rn "problemsetters/standards\|problemsetters/judge-model\|problemsetters/evaluator-sdk\|problemsetters/solution-sdk\|problemsetters/rpc\|problemsetters/runtimes\|problemsetters/capability-networking\|operators/storage\|users/ranking\|users/search-messages" noj-docs/docs --include='*.md' --include='*.ts' || true
```

预期：仅重定向页自身出现，正文链接无残留。

- [ ] **Step 2: 构建文档站**

运行：

```bash
cd noj-docs && npm run docs:build
```

预期：构建成功，无死链/编译错误。

- [ ] **Step 3: 人工检查侧边栏**

打开本地文档站，确认：
- 全局侧边栏显示“快速开始 / 面向角色 / 面向主题”。
- 各章节页面归属正确。
- 旧路径访问会跳转到新页面（或显示迁移提示）。
