## Why

当前 E2E 工作流每次运行需 ~8 分钟，其中 Docker 镜像重复构建（~3 min）、noj-tests 与 Judge E2E 顺序执行、Judge 测试编译串行是主要瓶颈。通过编排优化和 Docker 缓存复用，可在不影响正确性的前提下将 E2E 时间降至 ~4 min。

## What Changes

1. **Docker 镜像构建缓存** — 使用 `docker/build-push-action@v6` + `type=gha` 缓存层，跨 workflow run 复用已构建的 Docker 镜像层
2. **noj-tests 与 Judge E2E 并行化** — 将两者拆为独立 Job，利用 GHA 原生并行能力
3. **Judge 测试一次性编译** — 将串行 `for` 循环编译 5 个测试 target 改为 `cargo build --tests` 一次性编译
4. **服务启动等待优化** — 将闲置时间 2s 缩短为 1s，增加 timeout 上限保护

## Capabilities

### New Capabilities
- `e2e-optimization`: E2E 工作流编排优化，包括 Docker 缓存、测试并行化、编译优化

### Modified Capabilities
- `judge-e2e-test`: Judge E2E 测试编译方式从串行改为并行编译、测试步骤不改变
- `e2e-workflow`: E2E 工作流从单 Job 顺序执行改为多 Job 并行执行（需上下文共享）

## Impact

| 文件 | 变更 |
|------|------|
| `.github/workflows/e2e.yml` | 新增 Docker BuildKit 缓存配置；拆分 noj-tests 和 Judge E2E 为独立 Job；合并测试编译命令；优化等待循环 |
| `docker-compose.e2e.yml` | 考虑移除 MinIO（E2E 全用 STORAGE_PROVIDER=local 时不需 S3 mock） |
