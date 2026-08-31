# production-ip-default Specification

## Purpose

定义生产配置向导中服务器 IP 默认值行为，在保持 HTTPS 安全策略不变的前提下改善配置便利性。

## Requirements

### Requirement: DOMAIN 支持服务器 IPv4 默认值

前后端生产配置向导 MUST 在用户未提供现有 `DOMAIN` 时尝试检测服务器 IPv4，并将其作为输入默认值；用户 MUST 能直接输入域名覆盖该默认值。检测不到 IPv4 时 MUST 保持手动输入流程。

#### Scenario: 检测到服务器 IPv4

- **WHEN** 配置向导检测到有效的非回环 IPv4 且 `DOMAIN` 尚未配置
- **THEN** `DOMAIN` 输入项 MUST 展示该 IPv4 作为默认值
- **AND** 用户直接回车 MUST 使用该 IPv4

#### Scenario: 用户输入域名

- **WHEN** `DOMAIN` 输入项展示 IPv4 默认值
- **THEN** 用户输入合法域名后 MUST 使用用户输入的域名，而不是检测到的 IP

#### Scenario: 无法检测 IPv4

- **WHEN** 系统没有可用的首选 IPv4
- **THEN** `DOMAIN` MUST 继续要求用户手动输入，不得写入空值或回环地址

### Requirement: 生产 HTTPS 安全策略保持不变

IP 默认值 MUST 只改善配置便利性，不得放宽 `APP_URL` 的生产 HTTPS 校验；配置向导 MUST 提醒用户 IP 适合临时使用或已有 HTTPS 反向代理，正式部署建议使用域名。

#### Scenario: IP 作为默认 DOMAIN

- **WHEN** 用户接受 IP 默认值
- **THEN** `APP_URL` MUST 仍按 HTTPS 规则生成和校验
- **AND** 脚本 MUST 提示生产环境需要 HTTPS 访问路径
