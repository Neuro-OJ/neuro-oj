## 1. noj-core：速率限制

- [x] 1.1 在 `lib/hardening-rate-limit.ts` 新增 `enforceContestSubmissionRateLimit`、`enforceObjectiveSubmitRateLimit`、`enforceProblemCreateRateLimit`、`enforceProblemImportRateLimit`
- [x] 1.2 在 `routes/contests.ts` 的 `POST /:id/submit` 调用竞赛提交限流
- [x] 1.3 在 `routes/problems.ts` 的 `POST /:id/submit` 调用客观题提交限流
- [x] 1.4 在 `routes/problems.ts` 的 `POST /` 调用题目创建限流
- [x] 1.5 在 `routes/problems.ts` 的 `POST /import-bundle` 调用题目导入限流
- [x] 1.6 为新增限流补充路由/服务测试

## 2. noj-core：公开提交可见性

- [x] 2.1 `listSubmissions` 增加 `excludeContest` 参数，SQL 追加 `contest_id IS NULL`
- [x] 2.2 `GET /submissions/public/recent` 传入 `excludeContest: true`
- [x] 2.3 `getSubmission` 对 OI running 竞赛提交且非 owner/admin 时隐藏 `result`
- [x] 2.4 补充 `public/recent` 排除竞赛提交的测试
- [x] 2.5 补充竞赛提交详情可见性测试

## 3. noj-core：LLM 默认配额种子

- [x] 3.1 在初始化/种子流程中幂等写入默认 `llm_quotas`（global/user/problem × day/month）
- [x] 3.2 在 `.env.prod.example` 与 `noj-core/.env.example` 增加 LLM 默认配额相关环境变量说明
- [x] 3.3 补充种子幂等测试

## 4. noj-llm-gateway：配额 fallback 与监控

- [x] 4.1 `limits.ts` 的 `getQuota` 返回 null 时使用环境变量 fallback 上限
- [x] 4.2 `routes/llm.ts` 记录同一 submission 多来源 IP 的告警日志
- [x] 4.3 补充 fallback 配额单元测试

## 5. noj-judge：资源硬上限与结果合法性

- [x] 5.1 在 `config.rs` 增加 `MAX_EVALUATOR_TIME_MS`、`MAX_SOLUTION_CALL_TIMEOUT_MS` 等常量（支持环境变量）
- [x] 5.2 在 `dual/mod.rs` 对 `runtime_config` 执行时间/内存 clamp
- [x] 5.3 `build_judge_result` 增加状态白名单，未知状态映射为 `SystemError`
- [x] 5.4 `build_judge_result` 对 `score` 执行 `0..=10000` clamp
- [x] 5.5 补充硬上限与结果合法性单元测试

## 6. noj-judge：低风险加固

- [x] 6.1 `download.rs` 的 `verify_checksum` 在 expected 为 None/空时返回错误
- [x] 6.2 `cache.rs` 写入后设置文件权限 0600、目录权限 0700
- [x] 6.3 `cache.rs` rename 失败时删除临时文件
- [x] 6.4 `config.rs` 手写 `Debug` 对 `redis_url` 脱敏
- [x] 6.5 补充对应单元测试

## 7. noj-core：竞赛 SSE 脱敏

- [x] 7.1 `routes/sse.ts` 竞赛 SSE 对非 admin 剥离 `contest:submission:created` 事件中的 `user_id`
- [x] 7.2 补充 SSE 脱敏测试

## 8. 配置与文档

- [x] 8.1 更新 `.env.prod.example` 增加 judge 硬上限与 LLM 默认配额说明
- [x] 8.2 更新 `docker-compose.prod.yml`（如需传递新环境变量）
- [x] 8.3 更新相关 OpenSpec 主规范（`openspec/specs/`）同步增量

## 9. 验证

- [x] 9.1 noj-core 全量测试通过（`deno task test:parallel` 或 `deno task test`）
- [x] 9.2 noj-judge 单元测试通过（`cargo test`）
- [x] 9.3 noj-llm-gateway 测试通过（`deno task test`）
- [ ] 9.4 跨模块 E2E（noj-tests）通过
