## 1. noj-judge 依赖与基础设施

- [ ] 1.1 添加 Cargo 依赖：bollard、serde/serde_json、anyhow、thiserror、tracing、tracing-subscriber、uuid
- [ ] 1.2 构建 `noj-judge-python` Docker 镜像（`noj-judge/docker/python/Dockerfile`，基于 python:3.12-slim）
- [ ] 1.3 新建 `config.rs`：从环境变量读取 REDIS_URL、JUDGE_QUEUE、RESULT_QUEUE、MAX_CONCURRENT、WORK_DIR

## 2. noj-judge 类型与消息模块

- [ ] 2.1 新建 `types.rs`：定义 JudgeTask、JudgeResult、CaseResult、JudgeStatus 结构体，serde 序列化/反序列化
- [ ] 2.2 新建 `mq.rs`：实现 BRPOP 拉取任务 + LPUSH 发布结果

## 3. noj-judge Docker 沙箱

- [ ] 3.1 新建 `sandbox/mod.rs`、`sandbox/container.rs`：容器创建（bollard）、启动、等待退出、捕获输出、超时 kill
- [ ] 3.2 实现支持包获取（Base64 解码 / 本地路径读取）+ 解压（zip）与用户代码注入（写入 file_name 到临时目录）
- [ ] 3.3 配置安全限制：NetworkMode=none、Memory/NanoCpus 限制、AutoRemove、Binds 挂载

## 4. noj-judge 评测编排

- [ ] 4.1 新建 `judge/mod.rs`、`judge/runner.rs`：编排解包→写码→运行→解析→清理全流程
- [ ] 4.2 实现 `---RESULT---` 标记解析，提取 status/score/details 组装 JudgeResult
- [ ] 4.3 异常处理：容器超时→TimeLimitExceeded、OOM→MemoryLimitExceeded、非零退出→RuntimeError、无标记→SystemError

## 5. noj-judge 主循环

- [ ] 5.1 重写 `main.rs`：初始化 tracing、连接 Redis/Docker、Semaphore 并发控制、BRPOP 循环 + tokio::spawn 处理任务
- [ ] 5.2 添加 Docker daemon 启动时 Ping 检查，不可用时报错退出

## 6. noj-core 结果消费者

- [ ] 6.1 新建 `src/mq/consumer.ts`：BRPOP 阻塞消费 `noj:judge:results`，解析 JudgeResult JSON，调用 saveEvaluationResult
- [ ] 6.2 修改 `createSubmission()`：pushJudgeTask 前读取 support_package_path 指向的 zip 文件，Base64 编码后填入 JudgeTask.support_package_base64
- [ ] 6.3 在 `src/services/submissions.ts` 新增 `saveEvaluationResult()`：更新 submission 状态→finished，INSERT evaluation_results
- [ ] 6.4 修改 `createSubmission()`：pushJudgeTask 成功后立即更新 submission 状态 pending→judging
- [ ] 6.5 在 app.ts 启动时并行运行 result consumer（独立 Redis 连接，避免阻塞 HTTP）

## 7. 测试

- [ ] 7.1 noj-judge `types.rs` 单元测试：JudgeTask/JudgeResult 序列化反序列化，CaseResult 字段验证
- [ ] 7.2 noj-judge `runner.rs` 单元测试：`---RESULT---` 解析（正常、无标记、JSON 损坏）
- [ ] 7.3 noj-core 消费者 + 提交服务测试：状态流转验证
