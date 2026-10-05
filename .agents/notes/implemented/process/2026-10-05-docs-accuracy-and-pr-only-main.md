# Agent Note: 文档准确性修订与 main 改为仅经 PR 合入

Status: implemented

## Problem

2026-10-05 对根目录 AGENTS.md、README、CONTRIBUTING、`dev-docs/engineering/`、`noj-cli` README、noj-core / noj-ui 模块文档与运营者文档做了一轮核对，发现：

- **按文档操作会失败**：安装示例使用 `v0.9.5`，该 Release 没有 `docker-compose.prod.yml` / `env.prod.example` 资产；且 `install` 省略 `--ref` 时只选择纯 `X.Y.Z`、非预发布、资产齐备的 Release，目前不存在这样的版本，因此示例命令必然失败。
- **描述与实现不符**：`docker compose up -d` 实际还会构建并启动 `llm-gateway` 容器（与源码运行网关争用 8001 端口），文档却写"仅基础设施"；noj-core 启动顺序缺少 `TFA_ENCRYPTION_KEY` 校验、RBAC/系统设置初始化与生产配置校验；`testing.md` 的测试目录布局、"覆盖率不设 CI 硬门禁"与"后续计划"均已过时；`release.yml` 只监听 `prereleased`，文档写成同时监听 `published`；AGENTS.md §9.1 使用 jj 不存在的 `jj git push --force`。
- **规则自相矛盾或模糊**：AGENTS.md 允许直接推送 `main`，CONTRIBUTING 禁止；提交 scope 只列 `core/ui/judge/root`，实际提交大量使用多模块 scope 及 `ci`/`deps` 等；AGENTS.md 有两个 §7.2；源码开发流程漏掉 `deno task dev-setup`。

## Decision

- 按维护者决定，`main` 改为**禁止直接推送，一律经 PR 合入**；同步更新根 AGENTS.md §7.1 / §8.1 / §9.1、CONTRIBUTING、`development.md`、noj-core / noj-ui `AGENTS.md`。
- scope 扩充为模块 `core`/`ui`/`judge`/`gateway`/`cli`/`lmcc`/`docs`/`tests` 与横切 `root`/`ci`/`deps`，多模块用英文逗号分隔。
- 安装示例统一改为显式 `--ref "$VERSION"`，示例版本改为资产齐备的 `v0.10.4-rc.1`，并写明自动选版规则（纯 `X.Y.Z` 标签）与资产可用的起始版本（0.10.1-beta.2）。
- 按维护者决定**放宽 `noj-cli` 自动选版规则**：标签允许 SemVer 预发布后缀（与 judge `VERSION_RE` 一致），是否可选只看 GitHub 的 draft/prerelease 标记与资产是否齐备。发布流水线只在全部校验通过后才把预发布转正，转正即代表可用，不必再要求纯 `X.Y.Z` 标签。`isStableReleaseTag` 更名为 `isReleaseTag`。
- 启动顺序以 `noj-core/src/main.ts` 为准重写；`testing.md` 按当前布局与 CI 门禁更新；工程规范索引补齐缺失文档；修正章节编号、模块文档入口与 CI 工作流清单。

## Alternatives considered

- **给 compose 的 `llm-gateway` 加 `profiles` 使其默认不启动**：能让"仅基础设施"成立，但改变现有开发者的默认行为，本次只做文档修订，保留为后续选项。
- **保留"可直接推送 main"并只在 CONTRIBUTING 区分外部贡献者**：维护者明确选择统一走 PR。
- **保持纯 `X.Y.Z` 选版、尽快发布正式版**：维护者选择放宽规则，因为现有发布节奏以 rc/beta 转正为主。

## Consequences

- 新人按文档可完成安装与本地开发初始化；维护者自身也需走 PR，`main` 的变更都有 CI 与评审记录。
- 新版 CLI 省略 `--ref` 即可选中已转正的 `-rc.N` 等版本；但已发布的 v0.10.4-rc.1 及更早二进制仍是旧规则，文档示例继续显式写 `--ref`。
- `update --latest` 现在会跟随已转正的 alpha/beta/rc 版本；如需只跟随纯 `X.Y.Z`，应改为在发布流程中控制是否转正，而不是在 CLI 侧按标签过滤。
- 评审/审计类时点快照（如 `architecture-review-2026-09-12.md`）按文档时效约定不回溯修改。
