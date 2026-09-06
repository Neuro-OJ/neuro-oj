# Agent Note: 升级路径与 noj-cli 补齐 Release 资产就绪过滤

Status: implemented

## Problem

issue #431 的主体修复（#442）只把"资产就绪"过滤加到了安装器
`install.sh resolve_latest_ref`；两条仍然使用 `/releases/latest` 的路径
可以在维护者绕过预发布流程直接发布正式 Release 时选中缺少 CLI 资产的版本：

1. `noj-cli update --latest`（`scripts/deploy/production.sh
   latest_release_version`）只校验 draft / prerelease 标记，不校验资产，
   违反"安装与升级使用同一版本集合"的验收标准。
2. `noj-cli` 内部的 `resolveLatestVersion`（deploy init 向导与
   `ensureNojServerBinary` 的默认版本解析）同样未过滤。

## Decision

- `production.sh latest_release_version` 默认改用 `/releases?per_page=100`
  列表端点，用与 `install.sh resolve_latest_ref` 完全相同的 awk 过滤规则
  （稳定 tag + 非 draft + 非 prerelease + `noj-cli-linux-amd64` 与
  `.sha256` 资产齐全）选择版本；无可选版本时明确报错并提示固定版本升级。
  保留 `NOJ_UPDATE_API_URL` 自定义端点：响应为 JSON 数组时走列表过滤，
  单个对象时维持原有 draft / prerelease 校验（兼容既有测试钩子）。
- `noj-cli/src/runtime/download.ts resolveLatestVersion` 同步改为列表
  过滤，规则与安装器一致；无资产就绪版本时抛出明确错误。
- 测试：`test-noj.sh` 新增"拒绝缺少 CLI 资产的最新 Release"与"选择资产
  就绪的旧版本"两个用例（mock curl 支持 `NOJ_UPDATE_TEST_LIST` 返回
  列表 JSON）；`download_test.ts` 重写 `resolveLatestVersion` 用例，
  覆盖跳过 prerelease / draft / 缺资产版本、无可选版本抛错。
- 文档：`noj-docs/docs/operators/production-deploy.md` §5 说明
  `update --latest` 与安装器使用同一过滤规则。

## Alternatives considered

- 仅依赖预发布转正流程、不改升级路径：转正后的正式 Release 一定带资产，
  但维护者手动 published 的版本会绕过门禁成为 `/releases/latest` 的候选；
  双重过滤需要在所有默认选版本入口保持一致。
- 在 `resolveLatestVersion` 之外新增独立的"资产就绪版本解析"函数：调用方
  （deploy init 向导）没有需要区分的场景，两套入口反而容易漂移。

## Consequences

- `update --latest` 与安装器一样要求 Release 已上传 noj-cli 资产；如果
  未来引入其他分发渠道（不含 noj-cli 资产的正式 Release），需要同步调整
  `install.sh`、`production.sh`、`download.ts` 三处过滤规则。
- `resolveLatestVersion` 现在解析整个 Release 列表，请求体积从单对象变为
  分页列表（per_page=100），对公开仓库可接受。
