## 1. SSE E2E 测试

- [x] 1.1 Create `noj-tests/e2e/10_sse.test.ts` — SSE 连接 + 心跳 + 已终态提交立即推送
- [x] 1.2 认证保护测试：未登录 401、队列 SSE 端点保护
- [x] 1.3 模拟 Redis Pub/Sub 事件发布验证 SSE 推送内容

## 2. 私信 E2E 测试

- [x] 2.1 Create `noj-tests/e2e/11_messaging.test.ts` — 双用户注册与会话创建（201/200/400/404）
- [x] 2.2 消息发送 + 列表 + 已读标记 + 未读计数
- [x] 2.3 消息删除（视角隔离） + 非参与者权限验证
- [x] 2.4 私信 SSE 实时推送验证（连接 + 事件接收）

## 3. 审计日志 E2E 测试

- [x] 3.1 Create `noj-tests/e2e/12_audit_log.test.ts` — 7 类操作后审计记录存在性验证
- [x] 3.2 审计日志列表查询：时间筛选、分页、root 排除
- [x] 3.3 非 admin 访问 403 验证

## 4. 支持包 S3 E2E 测试

- [x] 4.1 Create `noj-tests/e2e/13_support_package_s3.test.ts` — S3 模式上传（含 MinIO 门控 skip）
- [x] 4.2 S3 模式下载 + 删除 + 权限验证（403/404）

## 5. 重测 E2E 测试

- [x] 5.1 Create `noj-tests/e2e/14_rejudge.test.ts` — 单条重测完整流程（pipeline 提交 → 重测 → 结果一致）
- [x] 5.2 不存在的提交 404、非 admin 403
- [x] 5.3 批量重测 + 活跃提交拒绝 + 重测审计日志验证

## 6. CI 冒烟测试

- [x] 6.1 Create `noj-core/tests/smoke.test.ts` — 核心 API 可达性验证文件
- [x] 6.2 Add `deno task test:smoke` 到 `noj-core/deno.json`
- [x] 6.3 Add `core-smoke` job 到 `.github/workflows/ci.yml`（PostgreSQL + Redis，无 judge）
