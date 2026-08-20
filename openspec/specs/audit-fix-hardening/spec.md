## Purpose

定义 2026-08-15 安全审计关键发现对应的加固要求，覆盖 XSS、存储路径穿越、生产启动校验、可信 IP 链路、敏感权限最小化与令牌脱敏。

## Requirements

### Requirement: 搜索高亮无 XSS
搜索高亮渲染 SHALL 只对受控 `<mark>` 标签输出 HTML，用户可控文本片段 MUST 先经 HTML 实体转义。

#### Scenario: 搜索词包含 HTML
- **WHEN** 搜索命中内容包含 `<img onerror=...>` 等用户可控文本
- **THEN** 页面仅显示文本，不得执行任何脚本或渲染注入元素

### Requirement: 存储 URL 受控
`support_package_storage_url` SHALL 仅接受服务端生成的 `noj-storage://` URL；存储层 MUST 对 key 做规范化和根目录约束，拒绝 `..`、绝对路径与跨对象 key。

#### Scenario: 客户端提交路径穿越 URL
- **WHEN** 创建或更新题目时提交含 `..` 或越权对象 key 的存储 URL
- **THEN** 服务端返回 400/403，且不发生任意文件或对象读写

### Requirement: 生产环境启动安全检查
当 `NOJ_ENV` 非 `test` 时，`DATABASE_URL` 缺失 MUST 导致启动失败；JWT 验证 SHALL 固定接受 HS256；`TRUSTED_PROXIES` 校验 SHALL 使用与运行时相同的系统设置数据源。

#### Scenario: 生产缺失 DATABASE_URL
- **WHEN** 生产环境启动且未配置 `DATABASE_URL`
- **THEN** 进程以清晰错误退出，不得静默使用内存数据库

#### Scenario: 非 HS256 JWT
- **WHEN** 请求携带 HS384 或 HS512 签名的 JWT
- **THEN** 认证失败

### Requirement: 客户端 IP 可信链路
后端获取客户端 IP 时 SHALL 仅信任来自 `TRUSTED_PROXIES` 链路提供的 `X-Forwarded-For`/`X-Real-IP`，UI 代理 MUST 透传客户端 IP 与 User-Agent。

#### Scenario: 直连伪造 X-Real-IP
- **WHEN** 非可信代理请求携带伪造的 `X-Real-IP`
- **THEN** 后端使用连接对端地址，不采用伪造值

### Requirement: 敏感权限最小化
普通注册用户 SHALL 不默认拥有 `evaluator.command` 与 `evaluator.network` 等敏感运行时字段的修改权限；JWT 中静态角色声明 MUST NOT 绕过实时 RBAC 与封禁状态检查。

#### Scenario: 普通用户创建题目时注入命令
- **WHEN** 普通用户提交自定义 evaluator 命令或开启网络
- **THEN** 服务端拒绝或剥离敏感字段

### Requirement: 安全事件不泄露令牌
邮件 mock Provider 日志 SHALL 对密码重置链接中的令牌脱敏；生产环境 MUST 使用真实邮件 Provider。

#### Scenario: mock 邮件发送
- **WHEN** 系统发送含重置令牌的 mock 邮件并记录日志
- **THEN** 日志中不得出现明文令牌
