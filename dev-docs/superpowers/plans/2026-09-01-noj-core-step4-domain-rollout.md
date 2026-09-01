# noj-core Step 4：其余域迁移推广 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Step 3 的 contest 试点模式推广到 `identity`、`catalog`、`objective`、`submission`、`community`、`messaging`、`system`、`gateway`、`query` 等域，使 `src/domains/` 成为 noj-core 业务代码的主要载体。

**Architecture:** 每个域按“移动文件 → 创建/补全门面 → 改接跨域导入 → 更新测试 → 跑 check-domains → 提交”的同一模式推进。保持同进程、同库，不改变业务行为。

**Tech Stack:** Deno 2、Hono、TypeScript、`scripts/check-domains.ts`。

**Spec:** `dev-docs/superpowers/specs/2026-09-01-noj-core-domain-isolation-design.md`
**Pilot Plan:** `dev-docs/superpowers/plans/2026-09-01-noj-core-step3-contest-pilot.md`

## Global Constraints

- 每个域一个独立 jj change，便于 review 与回滚。
- 所有提交 GPG 签名，中文 Conventional Commits。
- `check-domains --baseline dev-docs/engineering/domain-violations-baseline.txt` 必须保持通过。
- 迁移过程不改变 API 路径与业务行为。

---

## 迁移顺序

建议按依赖方向从“被依赖多”的域开始，减少临时门面数量：

1. `identity`（用户/RBAC 被大量依赖）
2. `catalog`（题目/标签被提交、竞赛、题单依赖）
3. `submission`（提交/评测被竞赛、统计依赖）
4. `community`（社区/通知被竞赛、私信等依赖）
5. `objective`
6. `messaging`
7. `system`
8. `gateway`
9. `query`

## 每域迁移 checklist

每个域执行以下步骤：

- [ ] 创建 `noj-core/src/domains/<domain>/` 目录（`routes/`、`services/`、必要时 `types/`）
- [ ] 将 `noj-core/src/services/<domain>/**` 与对应 `routes/**` 迁入
- [ ] 调整新文件内相对导入深度（统一比旧路径多一层 `../`）
- [ ] 创建或补全 `index.ts` 门面，导出其他域需要的函数与类型
- [ ] 将该域内部对旧 `src/services/<other>` 的深路径导入改为 `../../<other>/index.ts`
- [ ] 更新 `src/app.ts`、`src/routes/admin/index.ts` 等组合入口
- [ ] 更新 `noj-core/tests/**` 中引用旧路径的导入
- [ ] 运行 `deno run -A scripts/check-domains.ts --baseline dev-docs/engineering/domain-violations-baseline.txt`
- [ ] 运行 `cd noj-core && deno task check`
- [ ] 运行 `deno run -A scripts/check-all.ts`
- [ ] 用 `jj commit -m "refactor(core): <domain> 域迁移到 src/domains 并接入门面"` 提交

## 每个域的预期产物

| 域 | 迁移后主要目录 | 门面至少导出 |
|---|---|---|
| identity | `src/domains/identity/{routes,services,types}` | 用户查询、RBAC 判断、用户 ID 解析、封禁状态等被跨域使用函数 |
| catalog | `src/domains/catalog/{routes,services}` | 题目查询、标签查询、支持包下载等 |
| submission | `src/domains/submission/{routes,services}` | 提交查询/创建、评测结果读取、队列状态等 |
| community | `src/domains/community/{routes,services}` | 社区活动、通知、板块/帖子读接口等 |
| objective | `src/domains/objective/{routes,services}` | 客观题读接口、练习/竞赛提交读接口等 |
| messaging | `src/domains/messaging/{routes,services}` | 会话/消息读接口、未读数等 |
| system | `src/domains/system/{routes,services}` | 系统设置、审计记录、公告、封禁配置等 |
| gateway | `src/domains/gateway/{routes,services}` | LLM Provider 管理、用量查询等 |
| query | `src/domains/query/{routes,services}` | 搜索、统计、排行榜、Dashboard 等读模型 |

## 完成标准

- [ ] `src/services/` 下不再存在属于已迁移域的目录/文件（或仅保留待删除的空壳）
- [ ] 所有 `src/domains/**` 不再深路径导入其他域的 `services/`
- [ ] `check-domains --baseline` 无新增违规
- [ ] `check-all` 全绿
