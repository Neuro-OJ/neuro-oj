# prediction 单容器流程

> 双容器主流程见 [flow.md](flow.md)；wire 契约见 [protocol.md](protocol.md)。
> prediction 是**唯一不建 Solution 容器**的路径。

`runner.rs` 按 `submission_mode == "prediction"` 分派到
`src/prediction/mod.rs::evaluate_prediction()`：

```
任务到达
  │
  ├─ 0. clamp/validate runtime_config（solution 为 None，自动跳过其校验）
  ├─ 1. 获取支持包（与双容器同一套下载/校验路径）→ 注入 Evaluator /workspace
  ├─ 2. 只创建 Evaluator 容器（无 Solution；workspace_size_mb 取题目值或
  │     JUDGE_PREDICTION_WORKSPACE_MB）
  ├─ 3. 流式注入预测文件到 /workspace/prediction/<file_name>
  │     （inject_file_stream_to_container 自身无截止时间，调用方用启动期 30s 预算兜底）
  ├─ 4. 启动唯一 exec — Evaluator 跑 evaluate.py，注入 NOJ_PREDICTION_DIR /
  │     NOJ_PREDICTION_FILE
  ├─ 5. 流式读 stdout/stderr（append_capped 硬上限 1 MiB；标记流式检测），
  │     等 `---RESULT---` 后取下一非空行 JSON {score, details}
  ├─ 6. 读一次 Docker stats 回填 memory_kb
  └─ 7. dual.destroy() 清理 Evaluator 容器
```

- **绝不创建 Solution 容器**（E2E 以标签断言）。
- 结果解析与双容器共用 `build_judge_result`；标记缺失 / JSON 非法 / 启动超时 /
  `time_limit_ms` 超时均归 `SystemError`。
- 输出全文经 `append_capped` 累积（1 MiB，超出丢头部保尾部），标记检测用
  `LineParser` 流式完成，不依赖滚动缓冲重扫（避免 O(n²) 与标记被截断误判）。

## 与双容器路径的差异

| 维度              | 双容器                  | prediction                                                  |
| ----------------- | ----------------------- | ----------------------------------------------------------- |
| 容器数量          | Evaluator + Solution    | 仅 Evaluator                                                |
| 编排              | NDJSON 双向转发         | 无编排，只读 stdout/stderr                                  |
| `/workspace` 大小 | tmpfs 512M 起步         | 题目 `workspace_size_mb` 或 `JUDGE_PREDICTION_WORKSPACE_MB` |
| 输入              | 用户代码 + artifact zip | 预测文件流式写入 `/workspace/prediction/<file_name>`        |
| 结果解析          | `build_judge_result`    | 同左（共用）                                                |

## 验证

```bash
NOJ_RUN_E2E=1 cargo test --test e2e_prediction -- --ignored --test-threads=1
```

单元测试 `tests/prediction_units.rs` 不依赖 Docker，随
`cargo nextest run
--all-targets` 一起跑。`workspace_size_mb`
的有效范围与默认值见 [env.md](env.md) 的 `JUDGE_PREDICTION_WORKSPACE_MB`。
