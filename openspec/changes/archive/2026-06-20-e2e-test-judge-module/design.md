## Context

noj-judge 的核心评测流程依赖于 Docker 和 Redis
外部服务，但现有测试全部是脱离这些依赖的纯函数单元测试。CI 中 noj-judge
的测试在无 Docker 服务的 runner
上运行，无法验证容器创建、超时、OOM、网络隔离等关键行为。noj-core
侧的集成测试虽然使用了真实 PostgreSQL，但没有对 MQ 的端到端交互进行验证。

需要分层填补这个缺口，从「验证 Docker 沙箱本身」到「验证完整评测链路」。

## Goals / Non-Goals

**Goals:**

- 验证 Docker 容器创建/启动/等待/日志捕获的完整生命周期
- 验证资源限制（超时 kill、内存 OOM、CPU 限制、网络隔离）实际生效
- 验证支持包解压 + 用户代码注入 + 评测执行的全流程
- 验证 exit_code 推断逻辑（正常/超时/OOM/非零退出）在真实容器中正确
- 验证 noj-core → Redis MQ → noj-judge → 结果持久化的端到端链路
- 所有测试可门控、可自动化、不阻塞普通 CI

**Non-Goals:**

- 不替换现有单元测试（保持互补关系）
- 不覆盖 noj-ui 测试（前后端集成属于独立工作）
- 不做性能/压力测试（仅功能正确性验证）
- 不引入新的测试框架（复用 Cargo 的 `tests/` 和 Deno 的 `deno test`）

## Decisions

### D1: 分层测试架构

采用两层测试，按运行环境和成本分离：

```
┌─────────────────────────────────────────────────────────┐
│ Layer 2: 全链路 E2E (deno test + docker-compose)        │
│ 验证: noj-core → Redis → noj-judge → Docker → 数据库     │
│ 运行: 手动触发 / CI 独立 job                             │
│ 成本: 高（需 Redis + PostgreSQL + Docker）               │
├─────────────────────────────────────────────────────────┤
│ Layer 1: 集成测试 (cargo test + Docker daemon)           │
│ 验证: Docker 沙箱、资源限制、支持包注入                   │
│ 运行: NOJ_RUN_E2E=1 cargo test --test e2e               │
│ 成本: 中（仅需 Docker daemon + 测试镜像）                │
├─────────────────────────────────────────────────────────┤
│ Layer 0: 单元测试 (cargo test) [已有]                    │
│ 验证: 解析、序列化、分词、配置加载                       │
│ 运行: 每次 CI 自动运行                                   │
│ 成本: 低（无外部依赖）                                   │
└─────────────────────────────────────────────────────────┘
```

Rationale: 将 Docker 依赖的测试与纯逻辑测试分离，避免 E2E 基础设施不稳定影响普通
CI。

### D2: Rust 集成测试使用 Cargo `tests/` 目录

Rust 项目中 `tests/` 目录下的每个文件自动编译为独立的集成测试
crate。我们将测试放在 `noj-judge/tests/e2e/` 下，通过 `mod.rs` 组织子模块。

```
noj-judge/tests/
└── e2e/
    ├── mod.rs                 # 测试辅助工具 (test helpers)
    ├── docker_basic.rs        # 基础 Docker 操作测试
    ├── resource_limits.rs     # 资源限制测试（超时/OOM/CPU）
    ├── support_package.rs     # 支持包 + 代码注入测试
    └── security_isolation.rs  # 安全隔离测试（网络/敏感路径）
```

测试使用环境变量门控：`NOJ_RUN_E2E=1` 时运行，否则被 `#[ignore]` 跳过。 默认
`#[ignore]` 保证 `cargo test` 时自动跳过。

### D3: 测试用 Docker 镜像策略

不依赖 `noj-judge-python`（项目正式镜像），而是创建专用的轻量测试镜像。

```
noj-judge/tests/e2e/Dockerfile.test-runner
```

特点：

- 基于 `python:3.12-alpine`（镜像更小，下载更快）
- 仅安装运行测试所需的工具
- 包含一个简单的测试用 `evaluate.py`，可模拟各种 exit_code 和输出行为
- 测试中动态构建（`bollard` 的 `create_image`），不依赖 pre-pulled 镜像

这样 Layer 1 的集成测试完全不依赖外部镜像构建流程。

### D4: 超时测试用 wall-clock timeout

Rust 的异步测试需要设置合理的 wall-clock timeout 来防止 hang。使用
`tokio::time::timeout` 包裹每个测试，默认 30 秒超时。

超时验证（TLE）的实现：容器内运行 `sleep 60` 并用 `time_limit_ms: 1000` 触发
kill。

### D5: noj-core 侧集成测试用 `deno test` 驱动全链路

全链路 E2E 采用 Deno 脚本驱动，流程：

1. 调用 noj-core 的 `createSubmission`（直接函数调用，非 HTTP）
2. 验证 Redis MQ 中出现了 `noj:judge:queue` 消息
3. 模拟 noj-judge 的行为（或启动真实 noj-judge）消费任务
4. 验证 `saveEvaluationResult` 被正确调用且数据持久化
5. 验证 submission 状态从 `pending → judging → finished`

此测试需要 Redis 和 PostgreSQL 服务，通过 `.env.e2e` 配置连接。

### D6: CI 集成策略

E2E 测试不在标准 CI 中自动运行。采用两种触发方式：

1. **手动触发**: GitHub Actions `workflow_dispatch` 事件，可选择运行层（Layer1 /
   Layer2）
2. **Label 触发**: PR 打上 `e2e` label 时自动运行

这样避免 E2E 测试的延迟和基础设施要求阻塞日常开发。

## Risks / Trade-offs

| 风险                                           | 缓解措施                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------ |
| Docker 测试在 CI 中不稳定（daemon 偶尔不可用） | 所有集成测试 `#[ignore]` + 重试机制；失败不影响 CI 状态                  |
| 测试镜像构建耗时                               | 使用 alpine 基础镜像；支持 CI 缓存层                                     |
| 并发测试竞争 Docker 资源                       | 集成测试使用 `#[serial_test](https://docs.rs/serial_test/)` 确保串行执行 |
| 全链路 E2E 维护成本高                          | 仅保留 2-3 个核心场景，不追求全覆盖；Layer 1 已覆盖大部分风险            |
| 不同开发环境 Docker 行为差异                   | 使用 bollard 的 `create_image` 确保镜像一致；CI 中 pinned 镜像 tag       |

## Open Questions

- 全链路 E2E 中 noj-judge 是作为独立进程运行还是在 test runner 中内嵌启动？
  - 倾向：内嵌启动（`std::process::Command`），方便控制生命周期和收集日志
- Layer 2 是否需要启动真正的 noj-core HTTP 服务？
  - 倾向：不需要，直接调用函数层接口，跳过 HTTP 路由和中间件
