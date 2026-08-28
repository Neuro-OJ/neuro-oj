# NOJ 开发指南

本文档面向 NOJ 贡献者，汇总本地开发、提交、检查与协作流程。详细模块约定见各模块 `CLAUDE.md`。

## 本地环境

需要：Deno 2、Rust（judge）、Docker（judge E2E）、zip/unzip。

基础设施：

```bash
docker compose up -d
```

本地 Git hooks（可选，推荐）：

```bash
node scripts/install-git-hooks.mjs
```

一键启动/停止：

```bash
bash scripts/dev/devtool.sh start
bash scripts/dev/devtool.sh status
bash scripts/dev/devtool.sh stop
```

手动启动：

```bash
cd noj-core && deno task dev        # http://localhost:8000
cd noj-ui && deno task dev          # http://localhost:3000
cd noj-judge && cargo run           # 需要 Docker
cd noj-llm-gateway && deno task dev # 可选，LLM 题需要
```

## 常用命令

```bash
# noj-core
cd noj-core && deno task check       # fmt + lint + typecheck
cd noj-core && deno task test:parallel

# noj-ui
cd noj-ui && deno task check
cd noj-ui && deno task test

# noj-judge
cd noj-judge && cargo fmt --check
cd noj-judge && cargo clippy
cd noj-judge && cargo nextest run --all-targets

# noj-llm-gateway
cd noj-llm-gateway && deno task check
cd noj-llm-gateway && deno task test
```

## 提交规范

- 使用 jj 管理本地提交，推送使用 `jj git push`。
- 提交信息格式：`<type>(<scope>): 中文描述`
- type：`feat` / `fix` / `docs` / `style` / `refactor` / `perf` / `test` / `chore` / `ci` / `build`
- scope：`core` / `ui` / `judge` / `root`
- 所有提交必须 GPG 签名。
- 禁止直接推送到 `main`，所有变更通过 PR。

## 决策记录

非平凡变更必须新增或更新 `.agents/notes/implemented/` 下对应记录。

- 格式：`# Agent Note: <标题>` + `Status: implemented` + `## Problem` / `## Decision` / `## Alternatives considered` / `## Consequences`
- 校验：`deno run -A scripts/verify-agent-note-format.ts`

## 文档

- 根 `AGENTS.md` 只放“规则 + 链接”。
- 模块细节放各模块 `CLAUDE.md`。
- 工程规范放 `docs/engineering/`。
- Markdown 链接由 `scripts/verify-md-links.ts` 在 CI 检查。

## CI

- `.github/workflows/ci.yml`：PR/推送静态检查、测试、构建。
- `.github/workflows/e2e.yml`：跨模块全链路 E2E。
- 本地提交前至少跑相关模块的 `deno task check` 或 `cargo clippy`。
