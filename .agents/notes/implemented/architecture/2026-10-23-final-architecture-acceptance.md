# Agent Note: P3–P8 架构整治最终验收

Status: implemented

## Problem

P3–P8 的实现分散在多个批次和独立验证入口中，交接材料仍将 P3.4、P6、P7、P8 标记为
未完成，且最终回归曾被一个共享测试数据库中的随机题号夹具冲突阻断。若直接把分批绿灯
拼成总体验收，会遗漏 Core 全量回归、发布/恢复证据和浏览器/真实 Judge 的证据边界。

## Decision

完成 P3–P8 的实现、接线、旧实现删除、协议/发布合同和门禁同步；修复 admin upgrade-job
测试夹具，使域内题号在同一测试库中单调唯一。最终验收使用隔离 PostgreSQL、Redis、临时
存储和专用 rootless Docker daemon，保留每个证据层级的独立结论：

- Core `deno task test`：`2509 passed / 0 failed / 11 ignored`；
- Gateway `deno task test`：`182 passed / 0 failed / 1 ignored`；
- UI `deno task test`：`304 passed / 0 failed / 0 ignored`；
- CLI `deno task test`：`824 passed / 0 failed / 4 ignored`；
- Judge `cargo check --all-targets` 与 `cargo test --all-targets` 通过；Extension `npm test`
  为 `14 passed / 0 failed`，`npm run check` 通过；
- 严格模块边界扫描为 691 个生产文件、runtime/type SCC 均为 0、动态导入未解析数 0、
  110 张表、owner 缺口 0；Agent Note、Markdown 链接、migration safety、runtime contract
  和 release supply-chain 门禁通过。

P8 的真实恢复证据使用临时专用 rootless daemon 完成 `backup drill --skip-judge --keep`：
PostgreSQL、Redis、MinIO 恢复，迁移/数据核对，Core/Gateway 初始化，以及登录、题目读取和
摘要业务验收通过。完整 Judge verifier 由于 rootless slirp 网络不能从宿主机路由到容器 IP，
不计为完整 Judge 用户旅程通过。浏览器控制运行时因缺少对应服务模块，无法执行 SSR、
水合、SPA、响应式和键盘观察；UI 自动化测试不冒充浏览器证据。

## Alternatives considered

- 保留随机题号并重跑 Core：会继续依赖低概率夹具不冲突，不能证明全量回归稳定，拒绝。
- 用默认 Docker daemon 完成恢复演练：会扩大 `down -v` 的资源影响范围，违反隔离边界，拒绝。
- 将 `--skip-judge` 或 UI 单测升级为完整 Judge/浏览器验收：证据层级不同，拒绝。
- 因浏览器运行时缺失而改用独立 Playwright 或绕过浏览器控制策略：不符合当前环境的
  浏览器技能边界，拒绝；保留为明确未执行项。

## Consequences

主计划的 P3–P8 实现和自动化验收已收口，工作区保留真实资源隔离、发布集、升级恢复、旧
接口退役和模块边界证据。最终报告必须同时说明完整 Judge 和浏览器验收未通过/未执行，
不能把本轮结果描述为生产部署、浏览器验收或完整 Judge 端到端通过。生产环境、默认
Docker daemon、默认 PostgreSQL、Redis 和 MinIO 均未操作。

2026-10-24 在同一证据边界下重新执行 Core 全量套件：精确隔离 PostgreSQL/Redis 容器和
临时存储中的 `deno task test` 为 `2509 passed / 0 failed / 11 ignored`（20m29s）。本次
复验仅重启本轮指定的隔离容器，未操作默认或生产资源；原始日志为本机临时文件
`/tmp/noj-core-final-current-20261024.log`。
