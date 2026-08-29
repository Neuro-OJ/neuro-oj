# NOJ 配置分层

NOJ 使用“环境模板 + 本地覆盖 + 校验”的配置分层，不引入额外配置框架。

## 分层

| 层 | 文件 | 用途 |
|---|---|---|
| 开发模板 | `scripts/dev/env.example` | `devtool.sh init-env` 复制的默认模板 |
| 模块模板 | `noj-core/.env.example` / `noj-llm-gateway/.env.example` | 模块级环境变量说明 |
| E2E 模板 | `env.e2e.template` | 跨模块 E2E 固定测试配置 |
| 生产模板 | `.env.prod.example` | 生产部署变量模板（不含真实密钥） |
| 本地覆盖 | `noj-core/.env` 等 | 开发者本地实际值，gitignored |

## 规则

1. 新环境变量必须同步加入模块 `.env.example` 与 `scripts/dev/env.example`（或 `.env.prod.example`）。
2. 模板中禁止硬编码真实凭据；占位符应使用 `change-this-*` 等可被 `check-env.ts` 识别的形式。
3. 生产部署必须显式注入 `JWT_SECRET`、`DATABASE_URL`、`TRUSTED_PROXIES` 等关键变量。
4. `check-env.ts` 负责校验占位符与必填项，CI 不跑 strict 模式（CI 使用 Secrets）。

## 校验

```bash
cd noj-core
deno task check:env          # 基础校验
deno task check:env:strict   # 严格校验（本地开发用）
deno task check:prod         # 校验生产模板
```
