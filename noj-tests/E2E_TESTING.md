# E2E 测试指南

## 概述

本目录包含 neuro-oj 的全链路端到端（E2E）集成测试，验证从提交代码 → MQ 分发 → Judge 评测 → 结果回写 → 数据库持久化的完整流程。

### 测试架构

```
noj-tests/
├── deno.json                  # Deno 项目配置
├── E2E_TESTING.md             # 本文档
└── e2e/
    ├── e2e.test.ts            # 主测试文件（5 个测试用例）
    ├── helper.ts              # 辅助函数（API 客户端、Docker Compose 管理）
    └── support-package/       # 测试用支持包参考
        └── evaluate.py        # 示例评测脚本
```

### 测试覆盖

| # | 测试用例 | 验证内容 | 代码模板 |
|---|---------|---------|---------|
| 1 | Accepted | 正确代码获得 Accepted | `a + b` 正确实现 |
| 2 | Wrong Answer | 错误代码获得 WrongAnswer | 总是输出 0 |
| 3 | TLE | 死循环触发 TimeLimitExceeded | `while True: pass` |
| 4 | MQ 可靠性 | 结果被正确持久化到数据库 | 常规提交流程验证 |
| 5 | 无效消息容错 | 非法 JSON 不阻塞后续消费 | 注入后正常提交 |

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
