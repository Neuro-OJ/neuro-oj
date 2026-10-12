# Agent Note: 生产 compose 补齐 env 注入并新增注入一致性门禁

Status: implemented

## Problem

发布前检查发现 `docker-compose.prod.yml` 不使用 `env_file`，各服务只能读到 `environment:`
中显式插值的变量；而 `.env.prod.example` 声明的变量中有 15 个从未被注入任何容器，运维照文档
配置后静默无效：

- 邮件凭据 `ALIBABA_*` / `TENCENT_*`（7 个）：属于 bootstrap 配置（env 唯一事实源，后台只读），
  `EMAIL_PROVIDER=aliyun/tencent` 时 core 启动期生产配置校验必失败，服务无法启动；
- `NOJ_LLM_UPSTREAM_ALLOWED_HOSTS`（审计 G-03 刚引入）：内网自建模型无法放行，LLM 题升级后停摆；
- `NOJ_LLM_USAGE_RETENTION_DAYS`、`NOJ_LLM_MAX_CALLS/TOKENS`、`OBSERVABILITY_*`、`NUXT_SITE_URL`：
  设置无效。

E2E compose 硬编码了白名单，CI 无法发现；compose 内注释显示 month 配额变量此前已出过同类问题。

## Decision

- compose 为上述变量补齐插值：可选项以 `${KEY:-}` 注入空值（各读取点对空值回退代码默认），
  `NOJ_LLM_USAGE_RETENTION_DAYS` 默认 `90` 与网关一致；
- 新增 `scripts/check-prod-env-injection.ts` 并登记到 `gate-list.ts`：`.env.prod.example`
  中出现的每个变量（含注释示例行）必须在 compose 中以 `${KEY` 插值，或登记到 `NOT_INJECTED`
  白名单并写明原因（noj-cli 读取 / compose 固定值）；白名单陈旧条目同样报错；带零输入守卫。

## Alternatives considered

- 改用 `env_file: .env.prod`：会把 noj-cli 专用变量与全部密钥注入每个容器，扩大泄露面，
  且与现有"按服务最小注入"的约定相悖；
- 只补 LLM 网关两项：同类问题会在下一个新增变量时再次出现，需要门禁兜底。

## Consequences

- 启用邮件的生产部署可以正常启动；内网 Provider 可按文档放行；
- 新增生产变量时必须同时改 compose 或登记白名单，否则 CI 门禁失败；
- 门禁只检查"是否注入到某个服务"，不校验注入到了正确的服务。
