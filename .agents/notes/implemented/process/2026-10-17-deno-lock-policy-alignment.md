# Agent Note: 对齐 .gitignore 与 deno.lock 受控策略

Status: implemented

## Problem

根 `.gitignore` 的 Deno 段落曾有一行：

```text
deno.lock  # 不锁定依赖版本——社区库遵循 semver 即可
```

它与仓库实际策略相反：

- 5 个 `deno.lock` 均受版本控制：`noj-cli/`、`noj-core/`、`noj-llm-gateway/`、
  `noj-tests/`、`noj-ui/`。
- CI 用 `hashFiles('.../deno.lock', ...)` 作 Deno / npm 缓存 key，`ci.yml` 注释写明
  「deno.lock 是本项目唯一的锁文件真源」。
- `noj-cli` 的 `build:cli` 使用 `deno compile --frozen`，锁文件缺失或不一致即失败。
- `AGENTS.md` §8.1 与 `CONTRIBUTING.md` 均禁止手改锁文件。

该行同时是失效规则：`.gitignore` 不支持行尾注释，整行被当作字面模式
`deno.lock  # 不锁定依赖版本……`，从未匹配任何文件。规则未真正生效，但注释表达的
「不锁版本」意图会误导贡献者，也被 `dev-docs/superpowers/plans/2026-08-31-noj-cli-*`
等历史计划引用。

## Decision

- 删除根 `.gitignore` 的 `deno.lock` 行，改为说明性注释：锁文件受版本控制、是依赖
  事实源；依赖升级须经 `deno task` / `deno update` 并提交锁文件变更，禁止手改。
- 全仓检查其余 `.gitignore`（`noj-core/`、`noj-docs/`、`noj-ui/`），均未忽略
  `deno.lock`，无需改动。
- `CONTRIBUTING.md` 原句只写「不要修改……锁文件」，无法区分「手改」与「随依赖升级
  提交」，补一句「`deno.lock` 必须提交，禁止手改」，并把「不要修改」改为「不要手改」
  以与 `AGENTS.md` §8.1 用词一致。
- CI 表述已与策略一致（缓存 key + `--frozen`），不做改动。

## Alternatives considered

- 保留 `deno.lock` 忽略行、只改注释：忽略规则与「锁文件必须提交」仍自相矛盾，且
  新建的未跟踪锁文件会被静默吞掉，放弃。
- 改用 `!deno.lock` 否定规则覆盖：否定规则对已跟踪文件无意义，只是把矛盾从一行
  变成两行，放弃。
- 只在 `CONTRIBUTING.md` 补说明、不动 `.gitignore`：Issue 根因是忽略规则本身，
  文档补丁无法消除误导，放弃。
- 顺带给 CI 加锁文件一致性门禁（各模块 `deno install --frozen`）：属供应链加固，
  超出 #659 范围，另开 Issue 处理。

## Consequences

- `.gitignore` 不再暗示「不锁依赖版本」，新贡献者按注释即可知道锁文件要提交。
- 行为上无变化：原规则因行尾注释从未生效，5 个锁文件的内容与跟踪状态均未改动。
- `CONTRIBUTING.md` 与 `AGENTS.md` §8.1、CI 缓存 key、`noj-cli build:cli --frozen`
  的表述互相一致。
- 历史计划文档中「不锁 `deno.lock`，见仓库 `.gitignore` 注释」的时点记录按文档时效
  约定不回溯修改。
