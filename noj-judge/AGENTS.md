# noj-judge — Neuro OJ 评测 Worker

基于 **Rust + Docker** 的代码评测执行器。

## 职责

- 从 Redis MQ 拉取评测任务（Consumer）
- 在 Docker 容器中构建隔离的评测环境
- 执行用户提交的代码
- 限制资源使用（CPU、内存、时间、网络）
- 捕获执行输出并与预期输出对比
- 将评测结果返回给 noj-core

## 技术栈

| 组件         | 选择                  |
| ------------ | --------------------- |
| 语言         | Rust (Edition 2021)   |
| 异步运行时   | Tokio                 |
| Redis 客户端 | redis-rs (tokio-comp) |
| Docker API   | bollard / docker-api  |
| 沙箱         | Docker 容器           |

## 目录约定

```
noj-judge/
├── Cargo.toml
├── Cargo.lock          # 版本锁定（提交到 git）
└── src/
    ├── main.rs         # 入口
    ├── mq.rs           # Redis MQ 消费者
    ├── sandbox/        # Docker 沙箱管理
    │   ├── mod.rs
    │   ├── container.rs
    │   └── resource.rs # 资源限制
    ├── judge/          # 评测逻辑
    │   ├── mod.rs
    │   ├── compiler.rs # 编译阶段
    │   └── runner.rs   # 运行阶段
    └── types.rs        # 数据结构定义
```

## 编码规范

- 使用 `cargo fmt` 格式化
- 使用 `cargo clippy` 检查（禁止 warnings）
- 使用 `cargo test` 运行测试
- 错误处理：使用 `anyhow` 定义错误类型
- 日志：使用 `tracing` / `log` 记录关键操作
- 异步优先：所有 I/O 操作使用 async/await

### E2E / 集成测试

集成测试位于 `tests/` 目录，使用真实 Docker daemon 验证沙箱功能。

**文件列表：**
| 文件 | 验证内容 |
|------|----------|
| `tests/e2e_docker_basic.rs` | 容器生命周期、退出码、stdout/stderr 捕获 |
| `tests/e2e_resource_limits.rs` | 超时 kill、OOM、内存限制 |
| `tests/e2e_security_isolation.rs` | 网络隔离、敏感路径防护 |
| `tests/e2e_support_package.rs` | 支持包、evaluate.py 执行、---RESULT--- 标记 |

**运行方式：**
```bash
# 需要 Docker daemon 在运行中，且无 NOJ_RUN_E2E=1
NOJ_RUN_E2E=1 cargo test --test e2e -- --ignored

# 仅运行特定测试
NOJ_RUN_E2E=1 cargo test --test e2e -- --ignored test_container_lifecycle
```

**测试门控：**
- 所有集成测试默认被 `#[ignore]` 跳过
- 设置 `NOJ_RUN_E2E=1` 后方可执行
- 需要系统安装 Docker 并有权限访问 `/var/run/docker.sock`

### MQ 消息格式（JudgeTask → noj-judge）

```json
{
  "submission_id": "uuid",
  "problem_id": "1001",
  "judge_image": "noj-judge-python",
  "judge_command": "python3 /tmp/evaluate.py",
  "support_package_base64": "UEsDBBQAAAAIA...",
  "language": "python3",
  "code": "...",
  "file_name": "submission.py",
  "time_limit_ms": 5000,
  "memory_limit_mb": 512
}
```

支持包（zip）由 noj-core 读取后 Base64 编码，通过 `support_package_base64` 字段传输。

### 评测结果格式（JudgeResult → noj-core）

```json
{
  "submission_id": "uuid",
  "status": "Accepted | WrongAnswer | TimeLimitExceeded | MemoryLimitExceeded | RuntimeError | SystemError",
  "score": 1000,
  "output": "---RESULT---\n{\"status\":\"Accepted\",\"score\":1000,\"details\":{}}",
  "details": { "cases": [...] },
  "time_ms": 42,
  "memory_kb": 8192
}
```

- status 由 evaluate.py 输出 `---RESULT---` 标记后的 JSON 决定（可自由扩展）
- score 采用 ×100 整数存储（1000 = 10.00 分）
- time_ms / memory_kb 为可选字段（当前始终为 None，后续通过 Docker stats 实现）

## 安全注意事项

- **不可信代码执行**：所有用户代码必须在 Docker 容器内执行
- 禁止容器内网络访问（`--network none`）
- 严格限制 CPU 核心数和内存上限
- 禁止挂载宿主机敏感路径
- 设置最大并发任务数，防止资源耗尽
- 定期清理残留容器/镜像

## 贡献要求

- **所有提交必须 GPG 签名**（参见根目录 README.md 配置步骤）
- **仅通过 PR 贡献**，禁止直接推送到 main
- 提交信息遵循 Conventional Commits（`feat(judge): ...` / `fix(judge): ...`）

## 相关文档

- [Tokio 文档](https://tokio.rs/)
- [redis-rs 文档](https://docs.rs/redis/)
- [Docker Engine API](https://docs.docker.com/engine/api/)
