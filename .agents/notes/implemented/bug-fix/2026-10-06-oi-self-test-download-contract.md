# Agent Note: OI 自测包下载编码契约修复

Status: implemented

## Problem

OI 自测包将 base64 内容百分号编码，但既有 Worker 按原始 base64 解码，导致 `%` 字符触发下载失败，尚未编译就终止任务。

## Decision

Core 复用现有 `buildBase64DownloadUrl`，传入原始 base64，并附上实际 ZIP 字节的 SHA-256。Worker 对 content 增加百分号解码兼容，保持原始 `+` 字符，不采用会把它转为空格的表单解码。

## Alternatives considered

仅修改 Worker 会要求用户先重启或升级，当前 Core 的错误输出仍不兼容旧 Worker；仅移除 Core 编码则不能兼容已经排队的编码任务。两端分别保持旧协议输出和新输入兼容。

## Consequences

新自测任务兼容当前运行的旧 Worker。已排队的编码任务需使用更新后的 Worker 或重新自测。测试覆盖原始与编码后的 `+`、`/`、`=`、真实 ZIP 内容、SHA-256，以及缺省和空预期输出的区别。正式资源预算、WASM 计量标准和 Judge 的启停方式不变。
