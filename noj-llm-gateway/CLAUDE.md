# noj-llm-gateway（Deno + Hono）

## 模块职责

LLM 调用可信代理：托管 Provider Key（信封加密）、签发/校验 eval_token、 OpenAI
兼容代理、Redis 限流/额度、用量审计。core 通过 `/internal/*` 管理 API 配置
Provider/查询用量，judge 侧 evaluator 通过 `POST /v1/chat/completions` 携带
`NOJ_LLM_TOKEN` 调用。

协议 v3 强制使用域与评测尝试，Provider/用量/额度 API 通过受信任内部头绑定
Domain；默认域兼容入口固定映射 main。完整契约与集成验证命令见
[README](./README.md)。

## 开发命令

```bash
deno task dev        # --watch --env-file=.env -A src/main.ts
deno task start      # 启动
deno task test       # deno test -A --no-check
deno task check      # fmt --check + lint + typecheck
deno task db:migrate # 显式执行 LLM 表迁移并写入默认配额（幂等）
deno task db:generate # 时间戳前缀生成下一份迁移
```

## 关键约定

- 新环境变量必须加入 `noj-llm-gateway/.env.example` 与根目录
  `.env.prod.example`。
- 任何返回 Provider 的接口不得返回明文 `api_key`，统一走 `api_key_masked`。
- 限流/额度逻辑在 `src/limits.ts`，使用 Lua 脚本原子“检查 +
  自增”，新增维度需同步更新 Lua `meta` 结构。
- 审计统一走 `src/usage.ts` 的 `recordUsage`。
- 测试在 `tests/`，使用 FakeRedis 时需实现 `eval` 并 `await Promise.resolve`
  以满足 Deno lint `require-await`。
- `TEST_PG_ADMIN_URL` 与 `TEST_REDIS_URL` 是正式测试启动器的唯一资源入口；
  启动器为 child 派生
  `NOJ_GATEWAY_TEST_DATABASE_URL`、`NOJ_GATEWAY_TEST_REDIS_URL` 与 run
  prefix，结束时清理本 run 数据库和 Redis key。禁止对生产库运行集成测试。
- HTTP 启动只读校验打包 journal/SQL 与 `llm_schema_migrations` ledger；历史
  manifest 必须完整且 hash 固定，DDL 与默认配额必须由 `db:migrate` 或 Compose 的
  `gateway-migrate` 一次性服务显式执行。旧版无 hash/timestamp ledger 只能由
  显式迁移按当前固定 manifest 回填；回填是基线采纳，不证明旧执行字节。
