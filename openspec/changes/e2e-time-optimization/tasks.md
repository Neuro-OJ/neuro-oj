## 1. Docker 镜像构建缓存

- [ ] 1.1 设置 Docker BuildKit（`docker/setup-buildx-action@v3`）
- [ ] 1.2 将 noj-judge-python 镜像构建改为 `docker/build-push-action@v6` + `type=gha` 缓存
- [ ] 1.3 将 noj-core 镜像构建改为 `docker/build-push-action@v6` + `type=gha` 缓存（替换 `docker compose build` 中的 noj-core）
- [ ] 1.4 将 noj-judge 镜像构建改为 `docker/build-push-action@v6` + `type=gha` 缓存（替换 `docker compose build` 中的 noj-judge）
- [ ] 1.5 更新 `docker compose up` 命令，确保使用已缓存的本地镜像而非触发 `build:` 重新构建

## 2. noj-tests 与 Judge E2E 并行化

- [ ] 2.1 将 `deno test -A e2e/` 和 Judge E2E 测试运行合并到同一个 step，使用 `&` 后台并行
- [ ] 2.2 实现正确的退出码收集（`echo $?` → temp file → `wait` → read exit codes）
- [ ] 2.3 确保两组测试的输出可通过日志前缀或独立文件区分

## 3. Judge 测试编译优化

- [ ] 3.1 将串行 `for` 循环 `cargo build --test <target>` 改为 `cargo build --tests`
- [ ] 3.2 验证 `cargo test --test <target>` 复用 `cargo build --tests` 的编译产物

## 4. 服务启动等待优化

- [ ] 4.1 将轮询间隔从 `sleep 2` 缩短为 `sleep 1`
- [ ] 4.2 用 `timeout 60` 包裹等待循环，替代 `for i in $(seq 1 60)` 的手动计数

## 5. 验证

- [ ] 5.1 推送分支到 GitHub，确认 E2E 工作流 Docker 构建步骤显示缓存命中
- [ ] 5.2 确认 noj-tests E2E 和 Judge E2E 并行运行日志独立可读
- [ ] 5.3 验证 E2E 总时间从 ~8 min 降至 ~4-5 min
- [ ] 5.4 故意引入测试失败，验证并行模式下退出码收集正确，CI 准确报告失败
