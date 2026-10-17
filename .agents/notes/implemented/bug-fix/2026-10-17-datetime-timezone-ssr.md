# Agent Note: 提交时间格式化固定时区（SSR 水合不一致）

Status: implemented

## Problem

`noj-ui/utils/submissionFormat.ts` 的 `formatDateTime` 调用
`toLocaleString('zh-CN', {...})` 时未指定 `timeZone`，输出取决于进程时区。 SSR
容器为 UTC、浏览器为访问者本地时区（国内为 UTC+8），同一 ISO 时间在首屏
与水合后相差 8 小时，Vue 报 hydration mismatch，页面时间短暂闪烁。

受影响调用点包括
`pages/contests/[contestId]/index.vue`、`pages/admin/contests.vue`、
`pages/announcements/index.vue`、`components/feature/QueueRow.vue`、
`components/feature/contest/ContestRanking.vue`（均经 `useContests`
或直接引用）。 社区页已改用 `<NuxtTime>`，两套方案并存。

## Decision

在 `formatDateTime` 的 `Intl` options 中固定 `timeZone: 'Asia/Shanghai'`
（导出为 `DISPLAY_TIME_ZONE` 常量），使 SSR 与 CSR
输出逐字节一致，与进程时区无关。 同文件内没有其它 `toLocaleString` /
`toLocaleDateString` / `Intl.DateTimeFormat` 调用，根因只有一处。

`noj-ui/Dockerfile` 运行时阶段补 `ENV TZ=Asia/Shanghai`（原先未设置，基底为
UTC）， 消除其它依赖进程时区逻辑的隐式差异。仓库内无其它 `TZ` 配置，代码中对 UTC
的使用 （`getUTC*`、`toISOString`、按 UTC 自然日/月重置的配额窗口）均为显式 UTC
计算， 不依赖进程时区，故无冲突。

测试改为断言字面量输出，并覆盖跨日、跨年、带偏移量输入；用 `TZ=UTC` 与
`TZ=Asia/Shanghai` 分别运行验证结果一致。

## Alternatives considered

- 全站迁移到 `<NuxtTime>`：能统一时间渲染并自带时区处理，但涉及数十处调用点、
  组件 props 与格式差异，属于独立重构，本次不做，作为后续方向。
- 只在 Dockerfile 设置 `TZ`：SSR
  与容器一致，但访问者位于其它时区时仍会水合不一致，
  且依赖部署环境正确设置，不能替代代码内固定时区。
- 在 `formatDateTime` 中读取用户时区：需要额外的用户偏好存储与首屏可用性保证，
  收益不足。

## Consequences

站内时间统一以北京时间展示，非中国时区访问者看到的是北京时间而非本地时间，
这与站内其它中文文案（如"每日（UTC）"配额说明之外的时间展示）保持一致。
`utils/buildInfo.ts` 的 `formatBuiltAt` 仍按访问者本地时区渲染并附带时区标识，
属于"构建时间"语义，未在本次改动内；若后续出现页脚水合告警，应一并迁移到
`<NuxtTime>` 或传入固定时区。
