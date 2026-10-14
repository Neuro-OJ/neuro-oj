# Agent Note: 界面题消息发送使用普通 JSON 快照

Status: implemented

## Problem

真实浏览器中，界面题自测经 Judge 得到 100 分，宿主运行历史已显示成绩，但 iframe
仍显示“尚未运行”。浏览器报告 `DataCloneError`：Vue 将传入参数及结果变成
Proxy，`postMessage` 的 structured clone 无法克隆这些对象。已有组件桩只检查结果
props，未执行浏览器克隆过程。

## Decision

`UiFrame` 在唯一发送边界对既有 JSON 协议消息执行 JSON roundtrip，再调用
`postMessage`。初始化、结果更新和参数恢复都生成普通快照。字段和权限继续由现有协议与受裁剪
Domain DTO 决定。

新增组件回归在 `postMessage` 模拟中实际调用 `structuredClone`，验证响应式
`init`、`result`、`set` 的消息与快照独立性。真实浏览器输入模式旅程继续检查
iframe 的 `NOJ.onResult` 与参数回滚。

## Alternatives considered

- 在每个父页面使用浅对象或 `toRaw`：重复发送规则，且嵌套响应式值仍可能无法克隆。
- 捕获异常后丢弃消息：会保留用户看到的错误结果，掩盖协议实现缺陷。
- 修改评测 DTO 或移除结果回推：评测与授权正确，不解决消息边界问题。

## Consequences

消息只承载既定 JSON
值，没有新增异常兜底、网络入口或授权逻辑。测试包含真实浏览器失败证据，并通过组件
structured clone 验证最小修复；新运行栈的浏览器复验由集成阶段确认。
