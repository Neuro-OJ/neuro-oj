## Context

当前 E2E 工作流 (`.github/workflows/e2e.yml`) 在单个 `e2e` Job 内顺序执行所有阶段：构建 Docker 镜像 → 启动评测栈 → noj-tests E2E → 编译 Judge E2E 测试 → 运行 Judge E2E 测试 → 诊断/清理。

瓶颈分析（基于实际 CI 日志）：
- Docker 镜像构建占 ~3 min：noj-judge-python（python:3.12-slim 基础镜像拉取）、noj-core（deno install）、noj-judge（cargo build --release）。每次从零构建，不缓存层。
- noj-tests E2E（~60s）与 Judge E2E 编译+运行（~90s）顺序执行，互不依赖却无法并行。
- Judge E2E 测试编译用 `for` 循环串行 `cargo build --test <target>` 5 次，而非 `cargo build --tests` 一次性编译。
- 服务启动后健康检查用 `sleep 2` × 循环，浪费约 12-16s 空等。

## Goals / Non-Goals

**Goals:**
- E2E 时间从 ~8 min 降至 ~4-5 min
- Docker 镜像构建利用 GitHub Actions 的 `type=gha` 缓存层
- noj-tests 与 Judge E2E 测试并行执行（利用 GHA 多 Job 并行）
- Judge E2E 测试一次性编译（`cargo build --tests`）
- 保持 CI 正确性：任何步骤失败准确反映

**Non-Goals:**
- 不改变测试逻辑或测试门控策略（`NOJ_RUN_E2E=1` 守卫不变）
- 不引入外部缓存服务（sccache、Docker registry）
- 不修改测试代码本身
- 不引入 paths-filter 条件跳过（部分 PR 无 E2E 覆盖范围变更也仍需跑 E2E）

## Decisions

### 1. Docker 缓存策略：`type=gha` vs `inline` vs 自行维护 registry

**选择**: `docker/build-push-action@v6` + `type=gha`

替代方案对比:
- `type=gha`: GitHub Actions 原生支持，缓存层存储在 GHA blob store。跨 workflow run 共享。无需配置。
- `inline`: 仅在同一 workflow 内缓存，跨 run 不生效。E2E 运行频率不够高，收益有限。
- 自行维护 registry (如 docker hub + 每日 cron 推送)：过于重，适合高频 CI 团队。

影响: `docker compose build` 不支持 `cache-from` 直接传递，需要将 `docker-compose.e2e.yml` 中的 `build:` 改为从已缓存的本地镜像加载。具体做法：

a. 用 `docker/build-push-action` 构建 noj-core、noj-judge 镜像，推送到本地 Docker daemon（`load: true`）
b. `docker compose up` 使用 `image:` 字段引用已加载的镜像（而非 `build:` 触发重新构建）

### 2. Job 拆分方式：独立 Job vs 同 Job 后台 `&`

**选择**: 拆分为 3 个独立 Job：`build`、`e2e-tests`、`judge-e2e`

```
build → [e2e-tests, judge-e2e] 并行执行
```

替代方案对比:
- 同 Job 后台 `&`: 实现简单，但 `wait` 退出码问题难以可靠处理（见 `ci-optimize-deno-migration` 分析）。且日志交织。
- 独立 Job: GHA 原生并行，失败独立展示，日志隔离。代价是需要 GHA artifacts 共享产物。

产物共享方案: `build` Job 导出构建的 Docker 镜像为 tar + GHA artifacts → `e2e-tests` 和 `judge-e2e` 下载并 `docker load`。

但 Docker 镜像通常很大（noj-core ~600MB, noj-judge ~200MB），通过 artifacts 传输浪费 IO。更好的方案是：两个 Job 各自从缓存构建所需的镜像（缓存命中后极快）。

### 3. 实际实现：不拆分 Job，而是在同 Job 内并行阶段

经过分析，拆分为完全独立的 Job 在 Docker 镜像传输上代价过高。

**改为**: 保持单 Job，在 `docker compose up` 后，将 noj-tests E2E 和 Judge E2E 并行运行。使用显式 PID 捕获 + 退出码汇总：

```yaml
- name: 并行运行 E2E 测试
  run: |
    echo "启动 noj-tests E2E..."
    cd noj-tests && deno test -A e2e/ 2>&1 &
    PID1=$!
    
    echo "启动 Judge E2E..."
    cd noj-judge && cargo build --tests && \
      for target in e2e_docker_basic e2e_resource_limits e2e_security_isolation e2e_support_package e2e_problem_limits; do
        NOJ_RUN_E2E=1 cargo test --test "$target" -- --ignored --test-threads=1
      done 2>&1 &
    PID2=$!
    
    # 收集退出码
    wait $PID1; EXIT1=$?
    wait $PID2; EXIT2=$?
    
    echo "noj-tests 退出码: $EXIT1"
    echo "judge-e2e  退出码: $EXIT2"
    
    [ $EXIT1 -eq 0 ] && [ $EXIT2 -eq 0 ] || exit 1
```

关键点：使用 `wait $PID`（非 `wait` 无参数）精确等待每个进程，逐个收集退出码。最终 `[ $EXIT1 -eq 0 ] && [ $EXIT2 -eq 0 ] || exit 1` 确保任一失败都导致 step 失败。

### 4. Judge 测试编译：`cargo build --tests` vs 保持串行 for

**选择**: `cargo build --tests`

`cargo build --tests` 一次性编译所有 `#[test]` target，cargo 内部并行编译（使用 `-j` jobs）。等价于 5 次串行编译时间的 max 而非 sum。

`cargo test` 运行时仍需串行（`--test-threads=1`），以避免 Docker 资源竞争。

## Risks / Trade-offs

1. **[风险] 同 Job 内 `wait $PID` + 退出码收集仍不完美** →
   `wait $PID2` 在 PID2 已结束时返回 127（"no such job"）。需要用 `wait $PID2 2>/dev/null; EXIT2=$?` 然后在 PID2 结束时主动保存退出码。更稳健的做法：
   ```bash
   (cd noj-tests && deno test -A e2e/); echo $? > /tmp/exit1 &
   (cd noj-judge && ... && for ...); echo $? > /tmp/exit2 &
   wait
   EXIT1=$(cat /tmp/exit1)
   EXIT2=$(cat /tmp/exit2)
   ```

2. **[风险] `type=gha` 缓存大小限制** — GHA 的 cache 总大小 10GB/repo。Docker 镜像层可能较大（基础镜像 + 构建产物）。若缓存溢出则旧缓存被 LRU 淘汰。首次冷缓存无收益。
   → 缓解：使用 `mode=max` 确保中间层也缓存。

3. **[权衡] 同 Job 并行导致日志交织** → 两个 E2E 测试组的输出交织，排查失败时需要更多时间。但比顺序执行节省的 1.5 min 值得这一代价。
