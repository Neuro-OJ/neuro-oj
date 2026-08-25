# noj-llm-gateway（Deno + Hono）

## 模块职责

LLM 调用可信代理：托管 Provider Key（信封加密）、签发/校验 eval_token、 OpenAI
兼容代理、Redis 限流/额度、用量审计。core 通过 `/internal/*` 管理 API 配置
Provider/查询用量，judge 侧 evaluator 通过 `POST /v1/chat/completions` 携带
`NOJ_LLM_TOKEN` 调用。

## 开发命令

```bash
deno task dev        # --watch --env-file=.env -A src/main.ts
deno task start      # 启动
deno task test       # deno test -A --no-check
deno task check      # fmt --check + lint + typecheck
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
