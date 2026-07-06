## 1. CI 触发器恢复（P0）

- [x] 1.1 取消注释 `.github/workflows/e2e.yml` 第 17-19 行的触发器，启用 `push: [main]`、`pull_request: [main]`、`workflow_dispatch`

## 2. Pipeline 测试修复（P0）

- [x] 2.1 修复 `noj-tests/e2e/06_pipeline.test.ts` 第 32 行：`fetch("http://localhost:8000/...")` → `fetch(\`${BASE_URL}/...\`)`，并确认 `BASE_URL` 已从 `helper.ts` 导入

## 3. 恢复 ignore: true 测试（P1）

- [x] 3.1 `noj-tests/e2e/05_profile.test.ts`：6 个测试的 `ignore: true` → `ignore: skip`（测试 5.1、5.2、5.3、5.4、5.9、5.10）
- [x] 3.2 `noj-tests/e2e/09_checkin.test.ts`：2 个测试的 `ignore: true` → `ignore: skip`（测试 1.6 并发签到、1.7 多用户隔离）
- [x] 3.3 并发签到测试：降并发数 5→3，外层加 `Promise.race` + 10s 超时保护

## 4. MQ 层单元测试（P1）

- [x] 4.1 从 `noj-core/tests/services/submissions.test.ts` 提取 fake Redis（RESP 协议解析 + LPUSH/PING）到 `noj-core/tests/mq/_setup.ts`，增加 BRPOP/PUBLISH 内存实现
- [x] 4.2 创建 `noj-core/tests/mq/producer.test.ts`：测试 pushJudgeTask 成功 LPUSH、连接断开抛错、消息过大抛错、消息格式正确
- [x] 4.3 创建 `noj-core/tests/mq/consumer.test.ts`：测试 startResultConsumer 的合法消息处理、非法 JSON 跳过、缺少 submission_id 跳过、重连退避

## 5. 新建 problem_limits E2E 测试（P1）

- [x] 5.1 创建 `noj-judge/tests/e2e_problem_limits.rs`：复用 `common/mod.rs` 的 create_test_container/wait_container/is_e2e_enabled，实现 3 个测试（超时限制、内存限制、宽松限制正常完成）
- [x] 5.2 更新 `.github/workflows/e2e.yml` 第 138/146 行：在 build 和 test 循环中添加 `e2e_problem_limits`

## 6. 扩展 Pipeline E2E 覆盖（P2）

- [x] 6.1 `noj-tests/e2e/helper.ts` CODE_SAMPLES 新增：memoryLimitExceeded、runtimeError、syntaxError 三个样本
- [x] 6.2 `noj-tests/e2e/06_pipeline.test.ts` 新增 3 个测试：6/7 MLE、7/8 RE、8/8 语法错误
- [x] 6.3 `noj-tests/e2e/helper.ts` pollSubmission 默认参数调整：maxRetries 5→15，intervalMs 1000→2000

## 7. 扩展安全配置验证（P2）

- [x] 7.1 `noj-judge/tests/e2e_container_pool.rs` test_pool_security_config 函数：在现有 `hc.readonly_rootfs` 断言后新增 pids_limit=256、ipc_mode=none、no-new-privileges:true 三个断言

## 8. 验证与收尾

- [x] 8.1 本地运行 `cd noj-core && deno test -A tests/mq/` 确认 MQ 测试通过
- [x] 8.2 本地运行 `cd noj-judge && NOJ_RUN_E2E=1 cargo test --test e2e_problem_limits -- --ignored` 确认新测试通过
- [x] 8.3 本地运行 `cd noj-judge && NOJ_RUN_E2E=1 cargo test --test e2e_container_pool -- --ignored test_pool_security_config` 确认安全断言通过
- [x] 8.4 启动 E2E 栈 `docker compose -f docker-compose.e2e.yml up -d`，运行 `cd noj-tests && NOJ_RUN_E2E=1 deno test -A e2e/06_pipeline.test.ts` 确认 pipeline 修复生效
- [x] 8.5 运行 `cd noj-tests && NOJ_RUN_E2E=1 deno test -A e2e/05_profile.test.ts e2e/09_checkin.test.ts` 确认恢复的测试通过
- [x] 8.6 运行 `cd noj-core && deno test -A --parallel` 确认无回归
- [x] 8.7 运行 `cd noj-judge && cargo test` 确认无回归
