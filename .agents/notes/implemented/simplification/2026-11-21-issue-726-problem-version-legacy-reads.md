# Agent Note: #726 P1 第四批：删除无域题目草稿与版本读接口

Status: implemented

## Problem

0.11 删除无域出题写接口后，`problems/routes/problems.ts` 还留着四个读接口：
`GET /problems/:id/draft`、`/draft/preflight`、`/versions`、
`/versions/:versionId`。前端 `useProblemVersions` 仍封装这些路径，但页面与组件
只引用它的类型，函数本身没有调用方；剩下的调用方是 E2E 与一个 core 路由测试。

## Decision

- 删除四个路由及仅为它们服务的 `assertProblemReadable`、`trimVersionContent`
  等辅助函数。
- 不新增域端点：域入口已有 `draft`、`publish-preflight`、`versions`，指定版本
  用题目详情 `?version_id=` 读取（同样按当前权限裁剪）。
- 删除 `useProblemVersions.ts` 与其测试；仍在用的三个类型移入
  `useDomainProblemEditor.ts`。
- E2E 与 core 测试改走域入口；域草稿响应不包 `data`，断言随之调整。

## Alternatives considered

- **保留 composable 只改路径**：函数没有调用方，改路径只是维护死代码。
- **新增域 `versions/:versionId`**：与详情 `?version_id=` 重复，且旧接口的
  `is_latest` 字段没有前端使用者。

## Consequences

- 外部脚本调用旧路径会 404（CHANGELOG 标为破坏性）。
- `GET /api/v1/problems/:id` 与 `support-package`、`template`、`questions` 等
  无域读接口仍在，待后续单独评估。
