# Neuro OJ（NOJ）· AI 领域认证与竞赛评测平台

> 顶层 AI 指令：只放**禁令 / 命令 / 路由**；平台定位、模块职责与基础设施见
> [`dev-docs/agents/module-map.md`](dev-docs/agents/module-map.md)。

## 模块路由

| 模块 / 目录        | 落点（先读）                                                    | 一句话职责                                                        |
| ------------------ | --------------------------------------------------------------- | ----------------------------------------------------------------- |
| noj-core           | [`noj-core/AGENTS.md`](noj-core/AGENTS.md)                      | API、JWT 授权、业务 CRUD、Redis MQ、审计（Deno 2 + Hono）         |
| noj-ui             | [`noj-ui/AGENTS.md`](noj-ui/AGENTS.md)                          | Web 前端、Nitro 注入 JWT Cookie（Nuxt 4 + Vue 3）                 |
| noj-judge          | [`noj-judge/AGENTS.md`](noj-judge/AGENTS.md)                    | Docker 沙箱评测、双容器 Evaluator + Solution（Rust + Tokio）      |
| noj-llm-gateway    | [`noj-llm-gateway/CLAUDE.md`](noj-llm-gateway/CLAUDE.md)        | LLM 可信代理、Key 加密、eval_token、限流/额度/审计（Deno + Hono） |
| noj-cli            | [`noj-cli/README.md`](noj-cli/README.md)                        | 生产安装/启停/升级/备份恢复/配置校验（Deno 单二进制）             |
| noj-tests          | [`noj-tests/E2E_TESTING.md`](noj-tests/E2E_TESTING.md)          | 跨模块 E2E 测试                                                   |
| noj-docs           | [`architecture.md`](noj-docs/docs/system/architecture.md)       | 文档站：架构、运维、安全、FAQ                                     |

`noj-problems/`（独立私有仓库，主仓库 gitignore）与 [`noj-vscode`](https://github.com/Neuro-OJ/noj-vscode)（VS Code 扩展独立公开仓库）均不在本仓维护。目录用途、基础设施、文档加载
顺序与参考文档见
[`dev-docs/agents/module-map.md`](dev-docs/agents/module-map.md)。

## 禁令

1. 禁止直接推送 `main` 与 `rc/*`；变更从当前集成分支派生主题分支，经 PR 合入。
   集成分支不写死：以 `git branch -r` 与最近 tag 为准（2026-11 时为 `main` =
   `v0.11.0`）。
2. 禁止未签名提交；动代码前确认 GPG 可用（见 `workflow.md`）。
3. 禁止手改 `_journal.json`、`deno.lock`、`Cargo.lock`；迁移只能按编号追加。
4. 禁止在 `.env` 硬编码真实凭据；禁止直连生产库改 schema。
5. 禁止 `ALTER TABLE ... ADD COLUMN ... NOT NULL` 不带 `DEFAULT`；迁移必须三步式
   （可空列 → 回填 → `SET NOT NULL`）。
6. 禁止手拼 `deno test`；测试一律走 `deno task`。
7. 搜索用 `rg`，禁止 `grep`（环境无 `rg` 时才可回退）。
8. 多副本一致的状态必须走 Redis/DB；配置失效必须「重新加载」，禁止只
   `cache.delete()`。
9. 前端颜色与圆角禁止自创，遵循
   [`dev-docs/design/noj-design-tokens.md`](dev-docs/design/noj-design-tokens.md)。
10. 本地产物（AI/编辑器配置、日志、备份）不得提交。
11. 优先使用 `scripts/` 下的开发脚本，不要绕过既有门禁。

## 命令

**首次启动（仓库根）**

```bash
docker compose up -d
cd noj-core && deno task dev-setup
```

**静态检查（对应模块目录）**

```bash
deno fmt && deno lint        # noj-core / noj-ui
cargo fmt && cargo clippy    # noj-judge
```

**测试（仓库根，逐条执行；完整矩阵见 `testing.md`）**

```bash
cd noj-core && deno task test:parallel
cd noj-core && deno task test:domain <domain>
cd noj-tests && deno task test:domain <domain>
cd noj-tests && deno task test:domain cross-domain
cd noj-judge && cargo nextest run --all-targets   # 不含 Docker E2E；见 noj-judge/docs/testing.md 的 --ignored 命令
```

**迁移**

```bash
cd noj-core && deno task db:generate
```

## 指令文件预算

- 每份 `AGENTS.md` / `CLAUDE.md` 控制在 **2–5 KB**；超过 **200 行或 5 KB**
  就拆。
- 只放**禁令 / 命令 / 路由**三类内容。
- 细节放 `noj-<模块>/docs/` 或 `dev-docs/`；根文件只留路由表与必读约束。

## 深入阅读

- [`dev-docs/agents/module-map.md`](dev-docs/agents/module-map.md) — 模块职责、目录、架构方向、加载顺序
- [`dev-docs/agents/workflow.md`](dev-docs/agents/workflow.md) — 分支、jj、PR、提交信息、GPG、CI/CD
- [`dev-docs/agents/testing.md`](dev-docs/agents/testing.md) — 启动、测试矩阵、迁移、改动检查清单
- [`dev-docs/agents/conventions.md`](dev-docs/agents/conventions.md) — 编码规范、多副本、安全基线、品牌 Token
- [`dev-docs/engineering/README.md`](dev-docs/engineering/README.md) — 工程规范总览
