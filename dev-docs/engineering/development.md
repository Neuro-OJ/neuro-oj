# NOJ 开发指南

本文档面向 NOJ 贡献者，汇总本地开发、提交、检查与协作流程。详细模块约定见各模块 `AGENTS.md` / `CLAUDE.md`。

面向外部贡献者的入口是根目录的 [`CONTRIBUTING.md`](../../CONTRIBUTING.md)；安全问题请走 [`SECURITY.md`](../../SECURITY.md) 中的私下报告流程。

## 本地环境

需要：Deno 2、Rust（judge）、Docker（judge E2E）、zip/unzip。

基础设施（两段式开发的第一步，见下节）：

```bash
docker compose up -d
```

除 PostgreSQL / Redis / MinIO 外，根目录 `docker-compose.yml` 还会构建并启动
`llm-gateway` 容器（端口 8001）。若要从源码运行网关，先执行
`docker compose stop llm-gateway`。

本地 Git hooks（可选，推荐）：

```bash
node scripts/install-git-hooks.mjs
```

## 两段式开发

NOJ 源码开发**不使用** `noj-cli`（它面向生产部署与运维）。基础设施已由上一节
启动后，首次先初始化开发数据（幂等：迁移 → 系统数据 → 管理员引导 → 构建并导入
题目包 → E2E 用户）：

```bash
cd noj-core && deno task dev-setup
```

再按需在独立终端启动模块：

```bash
cd noj-core && deno task dev        # http://localhost:8000
cd noj-ui && deno task dev          # http://localhost:3000
cd noj-judge && cargo run           # 需要 Docker
cd noj-llm-gateway && deno task dev # 可选，LLM 题需要；先停掉 compose 中的 llm-gateway
```

Judge 不自动读取 `.env` 或 `.env.example`。本地 MinIO 使用 HTTP 时，在启动
Judge 的终端显式传入开关，否则任务会在下载测试数据包时因要求 HTTPS 而终止：

```bash
cd noj-judge
JUDGE_ALLOW_HTTP_S3=true cargo run --release
```

WASM 题还需通过启动环境设置 `JUDGE_WASI_CC`、`JUDGE_WASI_CXX` 和
`JUDGE_WASI_SYSROOT`，指向通过标准校验的 NOJ 修补版 SDK。只允许 HTTP 下载
不会自动启用 WASM 工具链。修改环境变量后需重新启动 Worker，失败提交需重测。

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
- scope：以根目录 `AGENTS.md` §7.3 为准（模块 `core` / `ui` / `judge` / `gateway` /
  `cli` / `lmcc` / `docs` / `tests`，横切 `root` / `ci` / `deps`，多模块用逗号分隔）
- 所有提交必须 GPG 签名。
- 分支与推送纪律以根目录 `AGENTS.md` §7.1 为准：**禁止直接推送 `main`**，所有变更
  从 `main` 派生主题分支并通过 PR 合入（2026-10-05 起）。

## 决策记录

非平凡变更必须新增或更新 `.agents/notes/implemented/` 下对应记录。

- 格式：`# Agent Note: <标题>` + `Status: implemented` + `## Problem` / `## Decision` / `## Alternatives considered` / `## Consequences`
- 校验：`deno run -A scripts/verify-agent-note-format.ts`

## 文档

- 根 `AGENTS.md` 只放“规则 + 链接”。
- 模块细节放各模块 `CLAUDE.md`。
- 工程规范放 `dev-docs/engineering/`。
- Markdown 链接由 `scripts/verify-md-links.ts` 在 CI 检查。

## CI

- `.github/workflows/ci.yml`：PR/推送静态检查、测试、构建。
- `.github/workflows/e2e.yml`：跨模块全链路 E2E。
- `.github/workflows/release.yml`：预发布 Release 的镜像与资产构建。
- `.github/workflows/lint-workflows.yml`：工作流 actionlint 检查。
- 本地提交前至少跑相关模块的 `deno task check` 或 `cargo clippy`。
