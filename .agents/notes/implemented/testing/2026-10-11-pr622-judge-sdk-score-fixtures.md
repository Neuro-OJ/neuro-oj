# Agent Note: 修正 Judge SDK E2E 评分夹具量纲

Status: implemented

## Problem

Judge 的 SDK `result.accept(score=...)` 接受百分制分数，并在输出协议前乘以 100。双容器 E2E 夹具把已经按平台协议缩放的 `1000`、`10000` 再次传入 SDK，评分校验启用后分别产生 `100000`、`1000000` 越界结果，使 CI 的 Judge Sandbox E2E 失败。

## Decision

将夹具中的 SDK 分数改为百分制输入：`1000` 改为 `10` 以保持存储分数 `1000`，`10000` 改为 `100` 以保持满分 `10000`。保留协议直写 JSON 的夹具不变，因为它已直接使用 ×100 整数。

## Alternatives considered

- 放宽 Judge 评分上限以接受夹具中的越界值：拒绝，因为规格规定成绩范围为 `0..10000`，且会重新引入非法评分覆盖成绩的风险。
- 在 SDK 中取消 ×100 转换：拒绝，因为 SDK 与 core 的平台成绩量纲契约要求百分制输入并统一存储为 ×100 整数。

## Consequences

双容器超时、能力调用和 artifact 注入 E2E 继续验证原有行为，同时输出合法的 `0..10000` 平台评分；Judge Sandbox CI 可执行完整测试组。
