## Purpose

定义 E2E 工作流编排优化规范，通过 Docker 缓存、阶段并行化和编译优化缩短 CI E2E 运行时间。

## Requirements

### Requirement: Docker 镜像构建缓存

E2E CI 工作流 SHALL 使用 GitHub Actions 缓存（`type=gha`）存储和复用 Docker 镜像构建层。

#### Scenario: 缓存命中时快速构建

- **WHEN** E2E 工作流运行且 GHA 缓存层中存在匹配的镜像层
- **THEN** Docker 构建仅重建变更层
- **THEN** 构建时间在缓存命中后不超过 2 分钟

#### Scenario: 冷缓存时完整构建

- **WHEN** E2E 工作流首次运行或缓存失效
- **THEN** Docker 构建从零完成所有层
- **THEN** CI 不因缓存缺失而失败

### Requirement: noj-tests 与 Judge E2E 并行执行

E2E CI 工作流 SHALL 在评测栈启动后就绪后，并行执行 noj-tests E2E 和 Judge Docker E2E 测试。

#### Scenario: 两者并行运行

- **WHEN** Docker Compose 评测栈所有服务健康且 noj-core API 可达
- **THEN** noj-tests E2E（`deno test -A e2e/`）和 Judge E2E 编译+测试并行启动
- **THEN** 任一测试组失败时整体 step 标记为失败

#### Scenario: 日志不互干扰

- **WHEN** 两组测试并行运行时
- **THEN** 每组输出使用独立日志文件或前缀区分

### Requirement: Judge E2E 测试一次性编译

E2E CI 工作流 SHALL 使用 `cargo build --tests` 一次性编译所有 Judge E2E 测试 target。

#### Scenario: 一次性编译所有测试

- **WHEN** E2E 工作流编译 Judge 测试
- **THEN** 使用 `cargo build --tests` 而非逐 target 的 `for` 循环
- **THEN** 编译产物被 `cargo test --test <target>` 复用

### Requirement: 服务启动等待优化

E2E CI 工作流 SHALL 使用合理的轮询间隔等待服务就绪。

#### Scenario: 轮询间隔不大于 1 秒

- **WHEN** CI 等待 noj-core 健康检查就绪
- **THEN** 轮询间隔不超过 1 秒
- **THEN** 总等待时间不超过 60 秒后超时
