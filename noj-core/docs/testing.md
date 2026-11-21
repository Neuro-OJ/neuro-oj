# 测试（noj-core）

> Agent 首选 `deno task test:domain <domain>`。所有正式入口统一由
> `scripts/test-launcher.ts` / `scripts/test-domain.sh` 管理隔离资源；手拼
> `deno test` 会丢失迁移、种子、环境变量与测试路径，禁止使用。

## 1. 命令

| 目的        | 命令                             | 说明                                                 |
| ----------- | -------------------------------- | ---------------------------------------------------- |
| 指定 Domain | `deno task test:domain <domain>` | Agent 首选；domain 为功能目录 / 旧模块 / legacy 别名 |
| 共享测试    | `bash scripts/test-shared.sh`    | 等价 `deno task test:shared`                         |
| 并行分片    | `deno task test:parallel`        | 每 shard 独立库 / Redis / 存储目录                   |
| HTTP 冒烟   | `deno task test:smoke`           | 启动器 smoke 模式                                    |
| 纯逻辑      | `deno task test:logic`           | 不需要外部资源                                       |
| 全量        | `deno task test`                 | 真实 PostgreSQL                                      |

- `test:domain` 由 `scripts/test-domain.sh` 转发。
- 缺 domain 直接退出 2；其余参数原样传给 Deno 测试。

## 2. 环境变量

启动器**不读 `.env`**，运行前必须提供：

```bash
export TEST_PG_ADMIN_URL=...
export TEST_REDIS_URL=...
export TEST_STORAGE_ROOT=...
export JWT_SECRET=...   # 足够强的测试密钥
```

- 启动器创建并清理独立测试库、Redis 资源与存储目录。
- 并行模式每个 shard 各自一套。
- 缺少依赖必须失败，禁止用 `ignore: true` 静默跳过。
- 不要用开发 `.env` 跑测试。

## 3. 测试写法

- 命名：`"<module>: <description>"`。
- 每个测试前调用 `resetDbForTest()`（`tests/helpers/db.ts`）。
- 路由测试用 `jsonRequest()`（`tests/helper.ts`）构造请求。
- `Deno.test` 使用 `sanitizeResources: false, sanitizeOps: false`（postgres.js
  连接池场景）。
- 顶层共享测试与跨模块测试放 `tests/`；`tests/00_migrate_test.ts` 最先执行。

## 4. 分层与延伸

| 层                       | 位置 / 命令                                                        |
| ------------------------ | ------------------------------------------------------------------ |
| 单元 / 集成（按 Domain） | `deno task test:domain <domain>`                                   |
| 共享                     | `bash scripts/test-shared.sh`                                      |
| 并行全量                 | `deno task test:parallel`                                          |
| 冒烟                     | `deno task test:smoke`                                             |
| 跨模块 E2E               | [`../../noj-tests/E2E_TESTING.md`](../../noj-tests/E2E_TESTING.md) |

测试分层背景见
[`../../dev-docs/engineering/testing.md`](../../dev-docs/engineering/testing.md)。
