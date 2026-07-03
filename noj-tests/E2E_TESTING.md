# E2E 测试指南

## 概述

本目录包含 neuro-oj 的全链路端到端（E2E）集成测试，验证从提交代码 → MQ 分发 → Judge 评测 → 结果回写 → 数据库持久化的完整流程。

### 测试架构

```
noj-tests/
├── deno.json                  # Deno 项目配置
├── E2E_TESTING.md             # 本文档
├── run-e2e.sh                 # 一键运行脚本
└── e2e/
    ├── helper.ts              # 辅助函数（API 客户端、Docker Compose 管理）
    ├── 01_categories.test.ts  # 分类管理（CRUD + 层级树）
    ├── 02_problems.test.ts    # 题目管理（U/P 型 CRUD + 筛选）
    ├── 03_auth.test.ts        # 认证流程（注册/登录/改密/管理员）
    ├── 04_submissions.test.ts # 提交流程（AC/WA/TLE + 查看结果）
    ├── 05_profile.test.ts     # 用户主页（信息+统计）
    ├── 06_pipeline.test.ts    # 全管道（提交→MQ→评测→结果）
    ├── 07_queue.test.ts       # 队列可见性+MQ可靠性
    ├── 08_password_change_guard.test.ts  # 强制改密守卫
    ├── 09_checkin.test.ts     # 每日签到
    └── support-package/       # 测试用支持包参考
        └── evaluate.py        # 示例评测脚本
```

### 测试覆盖

| 测试文件 | 测试内容 | 关键验证点 |
|---------|---------|------------|
| `01_categories.test.ts` | 分类 CRUD + 层级树 | 创建/更新/删除分类，父子层级 |
| `02_problems.test.ts` | 题目 CRUD + U/P 型 + 筛选 | 题型分离，URL 驱动筛选 |
| `03_auth.test.ts` | 登录/注册/改密/管理员 | JWT Cookie，强制改密守卫 |
| `04_submissions.test.ts` | 提交流程 AC/WA/TLE | 评测结果正确性 |
| `05_profile.test.ts` | 用户主页信息统计 | 通过数，AC 率 |
| `06_pipeline.test.ts` | 全管道端到端 | 提交→MQ→评测→结果→DB |
| `07_queue.test.ts` | 队列可见性 + MQ 可靠性 | 队列状态，非法消息容错 |
| `08_password_change_guard.test.ts` | 强制改密守卫 | 改密前访问限制 |
| `09_checkin.test.ts` | 每日签到 | 连续签到天数计算 |

## 前置条件

- Docker 及 Docker Compose V2
- 无需手动启动任何服务（测试自动管理）

## 运行方式

### 一键运行所有 E2E 测试

```bash
cd noj-tests
NOJ_RUN_E2E=1 deno task test:e2e
```

### 保留容器（调试用）

```bash
E2E_NO_CLEANUP=1 NOJ_RUN_E2E=1 deno task test:e2e
```

测试结束后容器保留，可手动排查问题。

### 调试技巧

```bash
# 查看 noj-core 日志
docker compose -f ../docker-compose.e2e.yml logs -f noj-core

# 查看 noj-judge 日志
docker compose -f ../docker-compose.e2e.yml logs -f noj-judge

# 手动进入 noj-core 容器
docker exec -it noj-e2e-core sh

# 手动启动/停止栈
docker compose -f ../docker-compose.e2e.yml up -d
docker compose -f ../docker-compose.e2e.yml down -v
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `NOJ_RUN_E2E` | — | 设为 `1` 启用 E2E 测试 |
| `E2E_BASE_URL` | `http://localhost:8099` | noj-core 地址 |
| `E2E_NO_CLEANUP` | — | 设为 `1` 不自动清理容器 |
| `E2E_JWT_SECRET` | `e2e-test-secret` | JWT 签名密钥 |

## CI 集成

E2E 测试在 `.github/workflows/e2e.yml` 中定义，在 PR 和推送到 main 时运行。

## 相关测试

- **noj-judge Rust E2E 测试**：`cd noj-judge && NOJ_RUN_E2E=1 cargo test -- --ignored`（低层 Docker 沙箱行为）
- **noj-core API E2E 测试**：`cd noj-core && deno test -A tests/e2e/api.test.ts`（33 个 HTTP API 测试）
