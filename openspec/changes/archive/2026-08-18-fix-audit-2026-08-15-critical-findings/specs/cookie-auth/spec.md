## ADDED Requirements

### Requirement: 代理透传客户端网络信息
Nitro 代理 SHALL 将原始请求的 `x-forwarded-for`、`x-real-ip` 与 `user-agent` 透传至 noj-core，使登录限流与 IP 封禁基于真实客户端地址。

#### Scenario: 客户端经代理登录
- **WHEN** 浏览器通过 noj-ui 代理登录
- **THEN** noj-core 看到的客户端 IP 与浏览器网络地址一致
