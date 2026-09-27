# Agent Note: AdminTable 未覆盖列整列空白（管理后台题号/标题不显示）

Status: implemented

## Problem

管理后台「题目管理」列表里**「题号」与「标题」两列整列空白**，而「类型」「难度」
「标签」「创建时间」「操作」正常显示——数据本身没问题（同一行的类型/难度都取到了）。

根因在通用表格组件 `AdminTable.vue` 的单元格渲染函数：

```ts
if (column.key === "actions" && slots.actions) return slots.actions({ row })
if (slots.cell) return slots.cell({ row, column })   // ← 只要"提供了"插槽就直接返回
const value = row[column.key]
return value === null || value === undefined ? "" : String(value)
```

组件注释写的契约是"**未提供插槽时**回退为原始值"，但页面的实际写法是
**部分覆盖**：`<template #cell>` 里一串 `v-if` / `v-else-if="column.key === ..."`
判定，没有 `v-else` 兜底。未命中任何分支的列不会产出内容——Vue 为 `v-if` 链
生成的是**注释占位节点**（`Comment`），于是该单元格渲染成空白，`row[key]`
回退分支永远不会执行。

按"列定义 − 插槽处理键"盘点，受影响的界面不止题目管理：

| 界面 | 曾整列空白的列 |
| --- | --- |
| `pages/admin/problems.vue`（全部题目） | 题号 `display_id`、标题 `title` |
| `pages/admin/problems.vue`（题目评定） | 题号、标题、所有者 |
| `pages/admin/tags.vue` | 标签名 `name`、题目数 `problem_count` |
| `pages/admin/llm/providers.vue` | `name`/`id`/`base_url`/`cost_per_1k_tokens`/`api_key_masked` |
| `pages/admin/llm/usage.vue` | `user_id`/`problem_id`/`provider_id`/`model`/`total_tokens` |
| `components/admin/TrainingManagementSection.vue` | 题单标题、题目数 |

既有 `AdminTable.spec.ts` 覆盖了"无插槽 → 回退"与"有插槽 → 走插槽"，但**没有**
覆盖"插槽部分覆盖"这一真实用法，因此这个缺陷一直没被测试拦住。

## Decision

把回退判定从"**是否提供**插槽"改为"**插槽是否真的渲染出了内容**"：
`AdminTable` 检查插槽产出，若全部为 `Comment` 占位节点、空 `Text`（如 `{{ '' }}`）
或空 `Fragment`，则视为该列没有自定义内容，回退渲染 `row[column.key]`
（`null`/`undefined` → 空串）。

- `isRendered()` 只做一层轻量结构判定（`Comment`/`Text`/`Fragment` 递归），
  不引入第二次插槽调用，也不改变插槽命中列的渲染结果。
- 回归测试加入 `tests/components/AdminTable.spec.ts`：部分覆盖列回退原始值、
  `{{ '' }}` 也回退、未覆盖列取值为 `null` 时渲染空串而不是 `"null"`、
  以及**按 `tags.vue` 形态复刻**的用例（名称/关联题目数回退，且数值 `0`
  必须渲染为 `"0"` 而不是被当成空值丢掉）。这四条在修复前会失败（已实测红）。
- 页面侧**不需要**改：既有 12 个管理页的部分覆盖写法从此都正确。

## Alternatives considered

- **逐个页面补 `v-else` 兜底**：12 个页面 + 未来的新页面都要记得写，同一类
  缺陷必然复发；且组件注释承诺的语义仍是错的。
- **要求插槽必须覆盖全部列**：Vue 模板层没有编译期保证，只能靠人眼与测试；
  而且会让每个页面都得复述"原始值"这一列渲染逻辑。
- **给列定义加 `fallback` 配置项**：多一层 API 表面积，实际只需要"没渲染就显示原始值"
  这一条规则。
- **只在 `problems.vue` 加兜底**：治标；其余 5 个界面继续空白。

## Consequences

- 管理后台 6 个界面的空白列恢复显示原始字段值；插槽作者不必再写兜底分支。
- 语义边界：插槽若**故意**渲染空内容（`{{ '' }}`、全 `v-if` 未命中的子元素），
  现在会显示原始值而非留白——这是期望行为（留白只会让管理员以为数据缺失），
  已在测试中固化。
- 未提供 `#cell` 插槽、`#actions` 插槽、分页/加载/错误/空态行为均不变。
