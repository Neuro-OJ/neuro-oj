## ADDED Requirements

### Requirement: 双信号优雅关闭
judge SHALL 同时监听 SIGTERM 与 SIGINT 触发优雅关闭，并在收到 shutdown 时不得丢弃已弹出的任务。

#### Scenario: 容器平台发送 SIGTERM
- **WHEN** judge 收到 SIGTERM
- **THEN** 在排空超时内等待在途任务完成，未处理任务安全回投

### Requirement: 结果解析与 rejudge_seq 保真
judge SHALL 跨输出 chunk 正确识别 `---RESULT---` 与其后 JSON payload，且所有评测结果（成功/超时/错误）MUST 携带与任务一致的 `rejudge_seq`。

#### Scenario: 标记与 payload 被 chunk 边界拆分
- **WHEN** stdout chunk 在 `---RESULT---` 与结果 JSON 之间分裂
- **THEN** judge 仍解析出正确结果

#### Scenario: 成功结果回传重测序号
- **WHEN** 任务 `rejudge_seq > 0` 且评测成功
- **THEN** 回传结果包含相同 `rejudge_seq`
