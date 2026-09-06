# 参与贡献

感谢你为 Neuro OJ（NOJ）贡献代码、文档、题目或问题反馈。NOJ 是独立社区项目；贡献前请先阅读 [README](./README.md) 和 [项目开发约定](./AGENTS.md)。

## 从哪里开始

1. 先搜索已有 Issue 和 Pull Request，避免重复工作。
2. 缺陷请使用 [缺陷报告模板](./.github/ISSUE_TEMPLATE/bug_report.md)，功能建议请使用 [功能建议模板](./.github/ISSUE_TEMPLATE/feature_request.md)。
3. 涉及安全漏洞时，不要创建公开 Issue，先阅读 [安全漏洞报告流程](./SECURITY.md)。
4. 进入模块目录前，阅读对应的 `AGENTS.md` 或 `CLAUDE.md`，并遵守其中更具体的约定。

## 本地环境

源码开发通常需要：

- Git
- Deno 2
- Rust stable（开发或测试 `noj-judge` 时需要）
- Docker Engine 与 Docker Compose v2（启动基础设施或运行 Judge 测试时需要）
- `zip` / `unzip`（构建或验证题目支持包时需要）

依赖只在需要的模块中安装或由 Deno/npm 自动准备。不要提交 `.env`、本地日志、构建产物或真实凭据。

## 启动开发环境

在仓库根目录启动 PostgreSQL、Redis 和 MinIO：

```bash
docker compose up -d
```

然后按需在独立终端启动模块：

```bash
cd noj-core && deno task dev
cd noj-ui && deno task dev
cd noj-judge && cargo run
cd noj-llm-gateway && deno task dev
```

`noj-llm-gateway` 为可选模块；`noj-judge` 需要 Docker 访问权限。也可以使用 `noj-cli` 的开发部署入口，具体命令见 [`dev-docs/engineering/development.md`](./dev-docs/engineering/development.md) 和 [`noj-cli/README.md`](./noj-cli/README.md)。

## 测试与检查

优先使用模块已有的 `deno task` 入口，不要手工拼接会遗漏环境配置的测试命令：

| 模块 | 快速检查 | 测试入口 |
| --- | --- | --- |
| `noj-core` | `cd noj-core && deno task check` | `deno task test:smoke`；完整测试使用 `deno task test:parallel` |
| `noj-ui` | `cd noj-ui && deno task check` | `deno task test` |
| `noj-judge` | `cd noj-judge && cargo fmt --check && cargo clippy` | `cargo nextest run --all-targets` |
| `noj-llm-gateway` | `cd noj-llm-gateway && deno task check` | `deno task test` |
| 跨模块 E2E | — | `cd noj-tests && deno task test` |

文档改动至少执行：

```bash
deno run -A scripts/verify-md-links.ts
```

若改动了 Agent Note，再执行：

```bash
deno run -A scripts/verify-agent-note-format.ts
```

按改动范围运行相关检查，并在 Pull Request 中记录实际执行的命令和结果。需要完整 CI 验证的改动仍应等待 GitHub Actions 完成。

## 分支与 Pull Request

当前仓库以 `main` 作为默认集成分支。日常开发建议从最新 `main` 创建主题分支：

```bash
git fetch origin
git switch main
git pull --ff-only
git switch -c docs/contributing-guide
```

完成修改后请创建 Pull Request，并将目标分支设置为 `main`；不要直接向 `main` 推送贡献提交。

提交 Pull Request 前请确认：

- 改动范围与 Issue 描述一致，并在 PR 中关联 Issue，例如 `Closes #433`；
- 代码、注释和文档使用中文，代码标识符使用英文；
- 未提交环境文件、凭据、日志、编辑器配置或构建产物；
- 已运行与改动相关的格式化、Lint、类型检查和测试；
- 非平凡变更已补充 `.agents/notes/implemented/` 下的 Agent Note；
- PR 描述中的验证清单与实际结果一致。

`main` 必须始终保持可部署状态。是否需要 PR 评审以维护者和仓库当前策略为准；需要评审的改动应从 `main` 派生主题分支并在合入前完成评审。

## 提交信息与签名

所有提交必须使用 GPG 签名，提交描述遵循中文 Conventional Commits：

```text
<type>(<scope>): <中文描述>
```

可用的 `type` 包括 `feat`、`fix`、`docs`、`style`、`refactor`、`perf`、`test`、`chore`、`ci` 和 `build`；`scope` 通常使用 `core`、`ui`、`judge` 或 `root`。

提交前先确认签名配置：

```bash
gpg --list-secret-keys --keyid-format LONG
git config --get user.signingkey
git config --get commit.gpgsign
jj config get signing.key
```

仓库本地工作流使用 Jujutsu（jj）时，通常采用：

```bash
jj describe -m "docs(root): 补充贡献指南"
jj sign -r @
jj git push
```

不要提交未签名提交，也不要修改迁移日志 `_journal.json` 或锁文件 `deno.lock` / `Cargo.lock`。

## 文档与决策记录

- 根目录 `AGENTS.md` 只维护规则和链接；模块细节放在对应模块文档中。
- 工程规范集中在 [`dev-docs/engineering/`](./dev-docs/engineering/README.md)。
- Markdown 相对链接必须指向仓库内存在的文件和标题。
- 改变流程、工具、测试策略或跨文件契约的非平凡变更，应记录决策、备选方案和后果。

如果不确定改动边界，先开 Issue 讨论；小而明确的修复可以直接提交 Pull Request。

相关入口：[README](./README.md) · [安全漏洞报告](./SECURITY.md) · [开发指南](./dev-docs/engineering/development.md) · [Pull Request 模板](./.github/pull_request_template.md)
