## ADDED Requirements

### Requirement: 私信功能动态开关
管理员 SHALL 能动态关闭私信功能。关闭后私信 API MUST 返回 `FEATURE_DISABLED` 403，前端隐藏入口，已有会话和消息 MUST 保留。

#### Scenario: 重新开启私信
- **WHEN** 管理员关闭后重新开启私信
- **THEN** 用户可继续读取原会话和发送消息
