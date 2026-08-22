## 1. 可信重置链接

- [x] 1.1 在密码重置服务中实现 `APP_URL` 优先解析、末尾斜杠规范化及生产环境缺失配置短路，确保缺失配置时不生成令牌、不发信并写入非敏感错误日志；同步更新路由与服务注释，并通过相关单元测试验证
- [x] 1.2 在 `noj-core/.env.example` 与 `scripts/dev/env.example` 增加 `APP_URL` 配置说明和本地开发示例，并通过文件检查确认两个模板均包含该配置

## 2. 回归测试

- [x] 2.1 增加已配置 `APP_URL` 时忽略恶意 `Host`/`X-Forwarded-Proto` 的测试，并验证邮件链接只使用可信配置 URL
- [x] 2.2 增加非生产环境回退和生产环境缺失 `APP_URL` 的测试，验证统一 200 响应、无令牌/邮件副作用及内部错误日志

## 3. 质量验证

- [x] 3.1 对变更文件运行 `deno fmt --check`、`deno lint` 和密码重置相关 `deno test`，确认格式、静态检查和回归测试通过
- [x] 3.2 运行 `openspec validate fix-password-reset-url --type change --strict`，确认提案、规格、设计和任务清单完整有效
