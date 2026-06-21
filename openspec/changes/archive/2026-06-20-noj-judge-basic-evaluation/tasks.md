## 1. noj-judge 依赖与基础设施

- [x] 1.1 添加 Cargo
      依赖：bollard、serde/serde_json、anyhow、thiserror、tracing、tracing-subscriber、uuid
- [x] 1.2 构建 `noj-judge-python` Docker
      镜像（`noj-judge/docker/python/Dockerfile`，基于 python:3.12-slim）
- [x] 1.3 新建 `config.rs`：从环境变量读取
      REDIS_URL、JUDGE_QUEUE、RESULT_QUEUE、MAX_CONCURRENT、WORK_DIR

## 2. noj-judge 类型与消息模块

- [x] 2.1 新建 `types.rs`：定义 JudgeTask、JudgeResult、CaseResult、JudgeStatus
      结构体，serde 序列化/反序列化
- [x] 2.2 新建 `mq.rs`：实现 BRPOP 拉取任务 + LPUSH 发布结果

## 3. noj-judge Docker 沙箱

- [x] 3.1 新建
      `sandbox/mod.rs`、`sandbox/container.rs`：容器创建（bollard）、启动、等待退出、捕获输出、超时
      kill
- [x] 3.2 实现支持包获取（Base64 解码）+ 解压（zip）与用户代码注入（写入
      file_name 到临时目录）
- [x] 3.3 配置安全限制：NetworkMode=none、Memory/NanoCpus 限制、Binds 挂载

## 4. noj-judge 评测编排

- [x] 4.1 新建
      `judge/mod.rs`、`judge/runner.rs`：编排解包→写码→运行→解析→清理全流程
- [x] 4.2 实现 `---RESULT---` 标记解析，提取 status/score/details 组装
      JudgeResult
- [x] 4.3
      异常处理：容器超时→TimeLimitExceeded、OOM→MemoryLimitExceeded、非零退出→RuntimeError、无标记→SystemError

## 5. noj-judge 主循环

- [x] 5.1 重写 `main.rs`：初始化 tracing、连接 Redis/Docker、Semaphore
      并发控制、BRPOP 循环 + tokio::spawn 处理任务
- [x] 5.2 添加 Docker daemon 启动时 Ping 检查，不可用时报错退出

## 6. noj-core 结果消费者

- [x] 6.1 新建 `src/mq/consumer.ts`：BRPOP 阻塞消费 `noj:judge:results`，解析
      JudgeResult JSON，调用 saveEvaluationResult
- [x] 6.2 修改 `createSubmission()`：读取 zip 文件 → Base64 编码 → 填入
      JudgeTask.support_package_base64
- [x] 6.3 在 `src/services/submissions.ts` 新增 `saveEvaluationResult()`：更新
      submission 状态→finished，INSERT evaluation_results
- [x] 6.4 修改 `createSubmission()`：pushJudgeTask 成功后立即更新 submission
      状态 pending→judging
- [x] 6.5 在 main.ts 启动时并行运行 result consumer（不阻塞 HTTP 服务）

## 7. 测试

- [x] 7.1 noj-judge 单元测试：36 tests pass
  - types.rs: 14 tests（serialize/deserialize、factory methods、CaseResult）
  - config.rs: 3 tests（默认值、自定义值、非法值回退）
  - container.rs: 10 tests（parse_command 7 种分词、extract_zip、path traversal
    防护、Base64 decode）
  - runner.rs: 9 tests（---RESULT--- 解析 5、process_output 状态推断 4）
- [x] 7.2 noj-core 类型测试：5 tests pass（scoreToDb/scoreFromDb 精度与边界）
- [x] 7.3 noj-core 提交服务测试：6 tests pass（含 saveEvaluationResult +
      幂等性，需 DATABASE_URL）
