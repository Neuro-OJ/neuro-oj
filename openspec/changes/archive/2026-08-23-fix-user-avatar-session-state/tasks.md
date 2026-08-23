## 1. Session 头像状态

- [x] 1.1 扩展认证响应解析，校验并保留可选的 `avatar_url` 字段；用认证 session 单元测试验证字符串、null 和缺失字段均按契约处理。
- [x] 1.2 让认证代理把规范化的 `avatar_url` 写入可读 session Cookie；通过代码检查确认无头像用户写入 `null`。
- [x] 1.3 让客户端从 session 恢复用户时保留头像状态，并在旧 session 缺少字段时刷新资料且先显示默认头像；通过类型检查确认旧 session 仍可解析。

## 2. 验证

- [x] 2.1 补充有头像、无头像和旧响应兼容的解析测试，并运行 `deno test -A tests/authSession_test.ts`。
- [x] 2.2 运行 noj-ui 格式化、lint 和相关测试，确认改动不影响现有认证与头像行为。
