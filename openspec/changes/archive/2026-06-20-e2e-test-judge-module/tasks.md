## 1. 集成测试基础设施

- [x] 1.1 创建 `noj-judge/tests/e2e/` 测试目录结构（`mod.rs` + 子模块文件）
- [x] 1.2 创建测试用 Dockerfile `noj-judge/tests/e2e/Dockerfile.test-runner`（基于 python:3.12-alpine）
- [x] 1.3 实现测试辅助模块 `mod.rs`：镜像检查/构建函数、容器创建辅助函数、测试门控（`NOJ_RUN_E2E`）
- [x] 1.4 添加 `serial_test` 依赖到 Cargo.toml dev-dependencies
- [x] 1.5 实现 `ensure_test_image()` 函数：检查本地镜像，不存在则用子进程 docker build

## 2. Docker 沙箱集成测试

- [x] 2.1 实现容器生命周期测试（`docker_basic.rs`）：创建 → 启动 → 执行 Python 代码 → 等待 → 日志捕获 → 清理
- [x] 2.2 实现超时 kill 测试（`resource_limits.rs`）：--hang 配合 time_limit_ms=3000 验证 exit_code=-1
- [x] 2.3 实现 OOM 测试（`resource_limits.rs`）：--memory-test 在 50MB 限制下验证 exit_code=137
- [x] 2.4 实现网络隔离测试（`security_isolation.rs`）：验证 NetworkMode=none 下网络请求失败
- [x] 2.5 实现支持包注入测试（`support_package.rs`）：evaluate.py + ---RESULT--- 标记 + 无支持包场景
- [x] 2.6 实现 exit_code 推断验证：分别验证正常退出(0)、非零退出(42)、超时(-1)、OOM(137) 的映射正确
- [x] 2.7 所有集成测试添加 `#[ignore]` + `#[serial_test::serial]` 属性 + tokio::time::timeout(30s) 保护

## 3. noj-core 侧 MQ 交互集成测试

- [x] 3.1 编写 consumer JSON 解析单元测试：有效 JSON 验证字段正确
- [x] 3.2 编写重复消费幂等性测试：推送两次相同 submission_id 的结果，验证不重复插入（已有）
- [x] 3.3 编写非法消息容错测试：非法 JSON 应抛出异常
- [x] 3.4 编写缺少 submission_id 的消息跳过测试

## 4. CI 集成

- [x] 4.1 在 `.github/workflows/ci.yml` 中新增 `judge-e2e` job（workflow_dispatch 触发）
- [x] 4.2 在 CI job 中构建 `noj-judge-test-runner` 镜像
- [x] 4.3 新增 `docker-compose.e2e.yml` 编排全链路测试环境（Redis + PostgreSQL + Docker-in-Docker）
- [x] 4.4 新增 `env.e2e.template` 配置模板
- [x] 4.5 添加 `workflow_dispatch` 事件支持手动触发 E2E 测试

## 5. 文档更新

- [x] 5.1 更新 `noj-judge/AGENTS.md`：添加集成测试运行方式、E2E 测试说明
- [x] 5.2 更新 openspec/specs/judge-worker/spec.md：扩展异常路径场景
- [x] 5.3 更新 openspec/specs/docker-sandbox/spec.md：补充资源限制验证场景

## 6. 验证

- [x] 6.1 运行全部单元测试：Rust 38/38 通过，Deno 32/32 通过
- [x] 6.2 集成测试编译成功（12 tests，因无 Docker 环境被 #[ignore] 跳过）
- [x] 6.3 clippy 无警告，cargo fmt + deno fmt 通过
