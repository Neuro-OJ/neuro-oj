## 1. 基础设施与配置

- [x] 1.1 创建 `noj-tests/` 独立包目录结构（deno.json、import_map.json、e2e/ 子目录）
- [x] 1.2 **扩展** `docker-compose.e2e.yml`——新增 noj-core 和 noj-judge 服务定义
- [x] 1.3 配置 noj-core 环境变量（数据库连接、Redis 连接、端口等）供 E2E 使用
- [x] 1.4 配置 noj-judge 环境变量（Redis 连接、Docker socket 挂载等）供 E2E 使用
- [x] 1.5 在 `noj-tests/deno.json` 中添加 `test:e2e` 任务，通过 `NOJ_RUN_E2E=1` 门控
- [x] 1.6 确保 `docker compose build` 可构建 noj-core 和 noj-judge 镜像
- [x] 1.7 为 noj-core 编写 `Dockerfile.e2e`（基于 `denoland/deno`，包含 migrate + seed 入口）

## 2. 移除 noj-ui 冒烟测试

- [x] 2.1 删除 `scripts/e2e/smoke.mjs`
- [x] 2.2 从 `noj-ui/package.json` 移除 `playwright` 开发依赖
- [x] 2.3 从 `.github/workflows/e2e.yml` 移除 noj-ui 冒烟测试相关步骤（Playwright 安装、noj-ui 启动、smoke.mjs 执行）
- [x] 2.4 从 `scripts/e2e/run-all.sh` 移除 noj-ui 冒烟测试调用
- [x] 2.5 从 `scripts/e2e/setup.sh` 移除 noj-ui 启动步骤（第 6 部分）

## 3. E2E 测试支持包

- [x] 3.1 在 `noj-tests/e2e/support-package/` 下创建测试用支持包目录结构
- [x] 3.2 编写 `evaluate.py`：读取输入、比对预期输出、返回评分 JSON（支持 Accepted / WA / TLE 三种模式）
- [x] 3.3 准备三组测试数据（复用已有 problem 1001 seed data）
- [x] 3.4 编写 `build-package.ts` 脚本：将支持包打包为 zip，供 docker-compose 挂载

## 4. E2E 测试脚本框架

- [x] 4.1 在 `noj-tests/e2e/` 下创建测试入口 `e2e.test.ts`（Deno test 格式）
- [x] 4.2 实现 `docker compose up/down` 辅助函数（启动/停止评测栈）
- [x] 4.3 实现 REST API 客户端：创建提交、查询 submission 状态、获取结果
- [x] 4.4 实现健康检查逻辑：等待所有服务就绪后再执行测试
- [x] 4.5 实现 `NOJ_RUN_E2E=1` 门控逻辑（环境变量未设置时跳过）
- [x] 4.6 实现 `--no-cleanup` 调试模式支持

## 5. 测试用例实现

- [x] 5.1 **Accepted 测试**：提交正确代码，断言最终 verdict 为 `Accepted`
- [x] 5.2 **Wrong Answer 测试**：提交有 bug 的代码，断言最终 verdict 为 `Wrong Answer`
- [x] 5.3 **TLE 测试**：提交死循环代码，断言最终 verdict 为 `Time Limit Exceeded`
- [x] 5.4 **MQ 可靠性测试**：提交代码后验证结果被持久化到数据库，消息不丢失
- [x] 5.5 **无效消息容错测试**：向结果队列推送非法 JSON，验证消费者跳过并继续

## 6. 迁移现有脚本到 Docker Compose

- [x] 6.1 **重写 `scripts/e2e/setup.sh`**：从手动启动后台进程改为 `docker compose -f docker-compose.e2e.yml up -d`
- [x] 6.2 **重写 `scripts/e2e/teardown.sh`**：从按 PID 停止进程改为 `docker compose -f docker-compose.e2e.yml down -v`
- [x] 6.3 简化 `scripts/e2e/core.sh`：run noj-core + noj-tests tests
- [x] 6.4 更新 `scripts/e2e/run-all.sh`：适配新的 setup/teardown 流程
- [x] 6.5 **简化 `.github/workflows/e2e.yml`**：移除 noj-ui 冒烟，添加 noj-tests 管道测试

## 7. 集成与文档

- [x] 7.1 创建 `noj-tests/E2E_TESTING.md` 文档，说明运行方式、环境变量、调试技巧
- [x] 7.2 在 `README.md` 中添加 E2E 测试章节（指向 noj-tests/）
- [x] 7.3 验证 `cd noj-tests && deno task test:e2e` 可重复执行且无残留（5/5 通过）
- [x] 7.4 验证 noj-judge 现有 Rust E2E 测试不受影响：`cargo test` 全部通过
