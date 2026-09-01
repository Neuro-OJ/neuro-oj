# noj-core Step 5：跨域引用清理与基线归零 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 清理所有历史跨域深路径导入，使 `scripts/check-domains.ts` 在没有 `--baseline` 的情况下也能直接通过，并移除基线文件。

**Architecture:** 基于 Step 3/4 已建立的 `src/domains/**` 门面，逐条修复 `dev-docs/engineering/domain-violations-baseline.txt` 中的 36 条历史违规。优先把跨域调用改为“目标域门面”或“读模型”；不适合门面的副作用改成事件订阅。

**Tech Stack:** Deno 2、Hono、TypeScript、`scripts/check-domains.ts`。

**Spec:** `dev-docs/superpowers/specs/2026-09-01-noj-core-domain-isolation-design.md`
**Dependencies:** `Step 3` / `Step 4` 完成后的域结构。

## Global Constraints

- 每个修复一个 jj change，提交信息中文 Conventional Commits。
- 不改变业务行为与 API 契约。
- 最终 `deno run -A scripts/check-domains.ts` 必须输出“域边界检查通过”并退出 0。

---

## Task 1: 盘点并分类历史违规

**Files:**
- Read: `dev-docs/engineering/domain-violations-baseline.txt`

**Interfaces:**
- Consumes: 基线违规清单。
- Produces: 每个违规对应的修复类型（门面替换 / 读模型 / 事件化）与负责人 Task。

- [ ] **Step 1: 阅读基线清单**

Run: `cat dev-docs/engineering/domain-violations-baseline.txt`
Expected: 列出所有 36 条违规。

- [ ] **Step 2: 按“源域 → 目标域 → 导入符号”建立修复表格**

将每条违规记录为：

```text
源文件 | 导入符号 | 目标 | 修复方式
```

示例：

```text
noj-core/src/services/contest/contest-clarifications.ts | createNotification | community | 改 import ../../domains/community/index.ts
noj-core/src/services/tags.ts | logAudit | system | 改 import ../../domains/system/index.ts
```

- [ ] **Step 3: 提交表格到文档**

将修复表格追加到 `dev-docs/engineering/domain-violations-cleanup.md`。

- [ ] **Step 4: 提交**

```bash
jj commit -m "docs(core): 整理域边界历史违规修复清单"
```

---

## Task 2: 修复门面可覆盖的违规

**Files:**
- Modify: 基线中所有“目标域已有门面”的源文件。
- Test: 对应域测试。

**Interfaces:**
- Consumes: Step 3/4 创建的各域 `index.ts` 门面。
- Produces: 源文件不再深路径导入其他域 service。

- [ ] **Step 1: 对每条可用门面替换的违规**

把：

```ts
import { foo } from "../services/<other>/<file>.ts";
```

改为：

```ts
import { foo } from "../domains/<other>/index.ts";
```

或根据新目录深度调整相对路径。

- [ ] **Step 2: 运行受影响测试**

Run: `cd noj-core && deno task test:smoke`
Expected: PASS

- [ ] **Step 3: 运行域边界检查（无基线）**

Run: `deno run -A scripts/check-domains.ts`
Expected: 违规数减少，但可能仍有剩余。

- [ ] **Step 4: 提交**

```bash
jj commit -m "refactor(core): 用域门面替换跨域深路径导入"
```

---

## Task 3: 为缺少门面的目标域补门面/读模型

**Files:**
- Create/Modify: 缺失的 `src/domains/<target>/index.ts` 或 `src/domains/<target>/services/read-models.ts`
- Modify: 相关源文件

**Interfaces:**
- Consumes: 目标域遗留 service 或已有 domain 实现。
- Produces: 所有被跨域使用的函数都能通过目标域门面导出。

- [ ] **Step 1: 对仍然缺失门面的目标域补充导出**

例如 `system` 域门面补：

```ts
export { logAudit } from "../../services/audit-log.ts";
```

- [ ] **Step 2: 替换剩余深路径导入**

同 Task 2 Step 1。

- [ ] **Step 3: 运行域边界检查（无基线）**

Run: `deno run -A scripts/check-domains.ts`
Expected: 0 违规。

- [ ] **Step 4: 运行 `check-all`**

Run: `deno run -A scripts/check-all.ts`
Expected: 全部通过。

- [ ] **Step 5: 提交**

```bash
jj commit -m "refactor(core): 补充域门面并清零跨域深路径导入"
```

---

## Task 4: 移除基线文件并收紧门禁

**Files:**
- Delete: `dev-docs/engineering/domain-violations-baseline.txt`
- Modify: `scripts/check-all.ts`

**Interfaces:**
- Consumes: `check-domains` 已能无基线通过。
- Produces: `check-all` 使用无基线模式，未来任何跨域深路径都会直接 fail。

- [ ] **Step 1: 修改 `scripts/check-all.ts`**

将：

```ts
  await run([
    "deno",
    "run",
    "-A",
    "scripts/check-domains.ts",
    "--baseline",
    "dev-docs/engineering/domain-violations-baseline.txt",
  ]);
```

改为：

```ts
  await run(["deno", "run", "-A", "scripts/check-domains.ts"]);
```

- [ ] **Step 2: 删除基线文件**

```bash
rm dev-docs/engineering/domain-violations-baseline.txt
```

- [ ] **Step 3: 运行无基线检查**

Run: `deno run -A scripts/check-domains.ts`
Expected: `域边界检查通过`

- [ ] **Step 4: 运行 `check-all`**

Run: `deno run -A scripts/check-all.ts`
Expected: 全部通过。

- [ ] **Step 5: 提交**

```bash
jj commit -m "ci(core): 域边界检查移除基线并强制零违规"
```

---

## 验收标准

1. `deno run -A scripts/check-domains.ts` 无参数直接通过。
2. `dev-docs/engineering/domain-violations-baseline.txt` 已删除。
3. `scripts/check-all.ts` 不再使用 `--baseline`。
4. `check-all` 全绿。
