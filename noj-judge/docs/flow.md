# 职责、技术栈与双容器主流程

> 由 [../AGENTS.md](../AGENTS.md) 路由进入的细节层。wire 契约与结果字段语义见
> [protocol.md](protocol.md)；无 Solution 容器的路径见
> [prediction.md](prediction.md)； 容器安全项与镜像见 [sandbox.md](sandbox.md)。

## 职责

从 Redis MQ 拉取评测任务（Consumer）→ 在 Docker 容器中构建隔离的评测环境 →
执行用户提交的代码 → 限制资源使用（CPU、内存、时间、网络）→ 捕获执行输出并与
预期输出对比 → 将评测结果返回给 noj-core。

## 技术栈

| 组件         | 选择                       |
| ------------ | -------------------------- |
| 语言         | Rust (Edition 2021)        |
| 异步运行时   | Tokio                      |
| Redis 客户端 | redis-rs 0.27 (tokio-comp) |
| Docker API   | bollard 0.21               |
| 沙箱         | Docker 容器                |

依赖清单以 `Cargo.toml` 为准（OI WASM 后端另有 `wasmtime`，fuel 与线性内存限额由
`src/oi/` 配置）。

## 双容器主流程

> 所有代码 / 产物评测统一走 `dual::evaluate_dual()`（Evaluator + Solution 双容器
> NDJSON 编排），旧的单容器路径已移除。**prediction 模式是唯一例外**：走
> `prediction::evaluate_prediction()` 单容器路径（见
> [prediction.md](prediction.md)）， 不创建 Solution 容器、无 NDJSON
> 编排。核心流程（`src/dual/mod.rs`）：

```
任务到达
  │
  ├─ 0. 白名单复验（镜像前缀 JUDGE_IMAGE_PREFIX / 命令可执行文件白名单 / 网络开关）
  ├─ 1. 获取支持包 — 缓存优先 → 按 host 分派下载（仅 HTTPS，禁重定向）→ SHA-256 校验 → 写缓存（含 zip 路径穿越/实时解压限额）；**获取或校验失败直接终止任务**（不静默放行空环境）
  ├─ 2. 创建 Evaluator + Solution 两个容器（cap_drop ALL / network none 默认 / pids_limit / 可配置 CPU 上限 / readonly rootfs + tmpfs）
  ├─ 3. 注入用户代码/artifact zip 到 Solution 容器（artifact 模式解压到 /workspace，入口 submission.py）
  ├─ 4. 注入支持包 zip 到 Evaluator 容器 /workspace（**全部文件写入同一个内存 tar 流，容器内只发起一次 `tar xf -` exec**）
  ├─ 5. 启动两个 exec — Evaluator 跑 evaluate.py；Solution 跑 host.py
  ├─ 6. Evaluator 首帧输出前受 30s 启动 deadline 约束；Solution 侧在就绪前只接受 `ready` 帧（其余忽略），无独立超时
  ├─ 7. 双向消息转发 — evaluator stdout ↔ solution stdin/stderr（调用级超时；帧写入受 3s 超时约束，超时/EPIPE 判定对端 stdin 已死并立即异常收尾）
  │     ├─ 超时 → 向等待方写入 CallTimeout/error 帧
  │     └─ 正常 → 读取 stdout/stderr 直到 RESULT 或 EOF
  ├─ 8. 等待 Evaluator stdout 出现 ---RESULT--- 标记，解析 JSON {score, details}
  │     ├─ 有标记 + 评分合法 → 统一映射 finished/error（分数是唯一结果）
  │     ├─ 有标记 + 评分非法（缺 score/非整数/越界）→ 平台错误（result_kind=platform_error）
  │     ├─ 总超时（启动超时 / time_limit_ms）→ SystemError（finalize_outcome 优先）
  │     ├─ 无标记 + 曾发送 CallTimeout 错误帧 → TimeLimitExceeded
  │     └─ 无标记 + 未发送 → SystemError
  └─ 9. 结果取得后立即收尾 → 显式 `dual.destroy()` 强制清理两个容器（编排循环不发 `shutdown` 帧、也不关闭 Solution stdin）
```

容器内是 NDJSON 编排：帧类型与写入超时的实现见 `src/dual/protocol.rs`、
`src/dual/frames.rs`、`src/dual/pipe.rs`。

## 超时处理细节

- 判定超时阈值 = `time_limit_ms`
- 超时由 judge 内部 deadline 判定（启动 30s / 题目 `time_limit_ms` / 调用级
  `call_timeout_ms`）
- 超时后通过 `dual.destroy()` 的 `docker rm -f` 强制清理容器
- 状态由 `finalize_outcome` 按超时来源与 CallTimeout 归因决定（总超时 →
  SystemError；仅调用级 CallTimeout → TLE）
- 输出从 Bollard exec 流实时收集（非 `docker logs`）

## 日志与指标

- 使用 `tracing` crate 输出结构化日志
- 关键事件：任务到达、评测开始/完成、超时、OOM、容器状态变化
- Prometheus 指标在 `src/metrics.rs`，优雅关闭时由 `src/drain.rs` 排空 in-flight
  评测任务
