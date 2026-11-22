# Agent Note: 修复 0.11 RC 发版阻塞项（性能基准、预发布转正、竞赛限额保留、IDE 资产）

Status: implemented

## Problem

对 `rc/v0.11`（`07ac076b`）做发版前审查时发现：

- `release.yml` 新接入的 `performance-gate` 必然失败：两份搜索性能基准仍向
  `domain_problem_bindings` 写入已被迁移 `0137` 删除的 `kind` 列。
- `publish-release` 无条件执行 `--prerelease=false --latest`，`v0.11.0-rc.1`
  会被转正为 Latest；而 `noj-cli` 自动选版只看 prerelease 标记、不看 `-rc`
  后缀，存量 `0.10.x` 执行 `update --latest` 会选中仅支持新装的 0.11 RC
  并被迁移守卫中止。
- 域内编辑比赛时前端只回传精简 `config`，后端整对象替换，导致后台设置的
  `submission_limits` 被清空（#726）。
- `release-set.json` 写入 `ide_version`，但发布流程不构建也不上传 `.vsix`。
- 公开域题目 `visibility` 是否阻断直链访问没有书面契约（#696）。

## Decision

- 两份 `search_bench.test.ts` 去掉 `kind` 列。
- `publish-release` 按标签区分：带 SemVer 预发布后缀的标签保持
  `prerelease=true`，只有 `vX.Y.Z` 转正为 Latest；RC 需
  `noj-cli install --ref <tag>` 显式安装。同步 `noj-cli` 注释、README
  与部署文档。
- 后端 `updateContest` 在输入未显式给出 `submission_limits` 时保留既有值，显式传
  `{}` 才清空；前端 `DomainContestForm` 保存时回传仍选中题目的既有限额。
- 新增 `publish-ide` job 打包 VSIX 及 sha256 并作为 `publish-release` 前置；
  供应链检查脚本与其测试覆盖缺失资产、漏等依赖两种情况。
- 维持公开域按 ID 直链可读的现状，在访问检查与 schema 注释、数据字典中写明契约。

## Alternatives considered

- **让 `noj-cli` 按 `-rc` 后缀排除**：需要存量 `0.10.x` 先升级 CLI
  才生效，无法保护已部署节点，故改在发布流水线侧保持 prerelease。
- **只修前端回传**：后台 API 调用方仍可能因部分更新清空限额，故后端同时做合并。
- **让 `problems.visibility`
  阻断直链**：属于行为变更，需团队确认，本次只固化现有契约。

## Consequences

- 0.11 RC 不再出现在
  `/releases/latest`，存量节点自动升级路径不受影响；稳定版发布行为不变。
- 前端移除全部带限额的题目时不回传
  `submission_limits`，后端保留旧条目（指向已移出比赛的题），不影响判题。
- 性能门禁与 VSIX 发布仍需在 PR 或预发布 Release 上实际运行一次确认。
