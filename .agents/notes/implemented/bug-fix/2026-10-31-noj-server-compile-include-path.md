# Agent Note: 修复 noj-server 编译 include 路径并加门禁

Status: implemented

## Problem

rc/v0.11 把 `src/domains/catalog` 迁到 `src/modules/problems`
后，`noj-core/Dockerfile` 与 `noj-core/scripts/build-server.sh` 中
`deno compile --include src/domains/catalog/services/oi-archive-worker.ts`
没有同步。实测 `deno compile` 遇到不存在的 `--include` 路径直接以 exit 1
失败，因此按 rc/v0.11 发版时 noj-server 生产镜像无法构建。该问题在处理 #698
P1-3（清理迁移期兼容层）时发现。

`scripts/deploy/verify-build-server.ts` 只检查脚本里是否出现
`deno compile`、目标平台和入口文件，不检查 include 路径是否存在，所以 CI
没有拦住。

## Decision

1. Dockerfile 与 build-server.sh 的 include 路径改为
   `src/modules/problems/services/oi-archive-worker.ts`（`oi-archive.ts` 以
   `new URL("./oi-archive-worker.ts", import.meta.url)` 启动该
   worker，必须随二进制打包）。
2. `verify-build-server.ts` 新增 `extractCompileIncludes` /
   `verifyCompileIncludes`，同时扫描 build-server.sh 与
   `noj-core/Dockerfile`，任一 `--include` 路径不存在即失败；补两条测试。

## Alternatives considered

- 去掉 `--include`、改为静态 import worker：worker 需要独立模块 URL 才能以 Web
  Worker 方式运行，静态 import 会改变运行模型。
- 只修路径不加门禁：下次模块迁移仍会静默漏改，只能等到发版构建时才暴露。

## Consequences

- noj-server 镜像与本地 `deno task build:server` 恢复可构建。
- 之后移动被 `--include` 的文件时，`verify-build-server` 门禁会在 CI
  中直接报出缺失路径。
