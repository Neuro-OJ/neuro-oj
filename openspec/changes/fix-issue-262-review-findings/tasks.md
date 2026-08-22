## 1. 注册并发冲突

- [x] 1.1 在注册用户 INSERT 的异常路径识别 PostgreSQL/PGlite `23505`，按用户名/邮箱唯一约束返回对应 `ConflictError`，并用服务测试验证并发注册只有一个成功且其余返回 409

## 2. 评测队列原子容量保护

- [x] 2.1 扩展 Redis 最小客户端接口和 fake Redis，支持 EVAL/LLEN 所需的测试协议，并验证现有 producer 测试仍可运行
- [x] 2.2 用 Redis Lua 原子脚本替换 producer 的 LLEN + LPUSH 竞态窗口，验证未满返回真实队列长度、已满拒绝且不写入

## 3. CORS 凭证与响应头

- [x] 3.1 将开发环境 CORS 改为受控本地来源，增加限流/请求追踪响应头的 exposeHeaders，并用 app 测试验证 Origin、credentials 和 expose headers

## 4. Judge Docker client 生命周期

- [x] 4.1 将启动时验证过的 Docker client clone 到评测任务，移除每任务重复连接，并通过 Rust 格式检查、cargo check 验证编译

## 5. Judge 评测并发上限

- [x] 5.1 在 judge Config 中加入 `JUDGE_MAX_CONCURRENT_JUDGES`，默认 2、无效值回退有限默认值，补充配置解析测试并更新 judge 文档/开发环境模板
- [x] 5.2 在主循环拉取前接入 semaphore 闸门，保证 in-flight task 不超过配置上限、任务完成/失败/drain 都释放额度，并通过 cargo test 验证

## 6. SSE 订阅权限上下文

- [x] 6.1 将提交 SSE 路由调用 `getSubmission` 时的 userRole 与 Hono Context 一并传递，确保实时 RBAC 权限检查与普通提交详情路由保持一致，并补充管理员订阅他人提交的路由测试

## 7. 提交服务模块依赖

- [x] 7.1 将 `getSubmissionQueueStatus` 从动态 import 改为静态导入，确认 `queue.ts` 不反向依赖提交 CRUD，并通过提交服务测试验证行为不变

## 8. 生产日志默认级别

- [x] 8.1 将生产环境未配置 `LOG_LEVEL` 时的默认级别设为 `warn`，更新环境模板，并补充显式配置覆盖与默认值测试

## 9. 综合验证

- [ ] 9.1 运行 OpenSpec validate、core deno fmt/lint/相关测试、judge Rust 格式检查/clippy/test，并审查最终 diff 确认没有混入工作区既有变更
