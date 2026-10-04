# Agent Note: GitHub Actions 引用全部固定到 commit SHA 并加门禁

Status: implemented

## Problem

2026-09-28 审计 S1（High，影响面 Critical）：`.github` 下 175 处 `uses:` 中**零处**固定到 commit
SHA，全部是 `@v4`、`@stable` 这类可变引用；而 `release.yml` 持有
`packages / id-token / attestations / contents: write` 并以 `--clobber` 覆盖 Release 资产。任一上游
action 的 tag 被篡改，即可污染此后所有 install/update。同时 `dependabot.yml` 注释声称"已 SHA 钉"、
`check-supply-chain.sh` 只校验 Dockerfile，形成虚假安全感；dependabot 只扫 `/`，composite action
（`.github/actions/*`）中的引用永远不会被升级。

## Decision

- 162 处外部 action 与 1 处 `docker://` 引用全部改为 `owner/repo@<40 位 SHA> # <精确版本>`、
  `docker://image@sha256:<digest> # <版本>`。SHA 取自当前 tag 指向的提交，并逐一用 GitHub compare API
  核对其位于官方默认分支或发布分支（`releases/v4`、`cosign-installer-v3`、`releases/v3`、`stable`）
  的历史中，排除"tag 指向分叉伪造提交"的情况；
- `dtolnay/rust-toolchain` 原以 ref 名 `@stable` 推断工具链，固定 SHA 后三处显式声明
  `toolchain: stable`；
- 新增 `scripts/check-action-pins.ts`（含自测）并接入 `REPO_GATES`：浮动 tag / 分支、缺版本注释、
  未固定 digest 的 docker 引用一律失败；本地 action 豁免；
- `dependabot.yml` 更正不实注释，改用 `directories: ["/", "/.github/actions/*"]` 覆盖 composite action。

## Alternatives considered

- 只固定 `release.yml`：其他 workflow 同样持有 `GITHUB_TOKEN` 并运行在同一仓库，攻击面不止发布链；
- 使用 StepSecurity 等第三方自动钉工具：引入新的供应链依赖，且同样需要门禁防回退。

## Consequences

- 升级 action 依赖 Dependabot PR（会同步改写 SHA 与版本注释）或人工按门禁提示查询 SHA；
- `dtolnay/rust-toolchain` 的 `stable` 分支频繁前移，固定后 Rust 工具链版本冻结在本次 SHA 对应的
  stable，需随 Dependabot 或人工更新；
- `release.yml` 的 `--clobber` 与发布资产信任锚（S3）不在本次范围。
