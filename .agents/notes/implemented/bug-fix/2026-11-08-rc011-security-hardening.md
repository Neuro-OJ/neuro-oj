# Agent Note: rc/v0.11 安全加固（内部端点暴露、演练出站、解压限额、judge 超时、OAuth 封禁、密钥掩码）

Status: implemented

## Problem

对 `rc/v0.11`
做全模块安全审查后，经逐条核对代码确认以下问题（均为中低危，无高危）：

1. **内部端点公网可达**：nginx → noj-ui Nitro 代理只做 `/api/v1/` 前缀白名单，
   `/api/v1/internal/*`（排空、内部服务）可从公网到达 core。其中已弃用的
   `GET /api/v1/internal/llm/quota-caps` 用 `NOJ_LLM_SERVICE_TOKEN` 鉴权，而该
   token 同时是 eval_token 的 AEAD 主密钥，属于不必要的暴露面。
2. **恢复演练沿用生产出站配置**：演练用快照 `.env.prod` 与恢复出的
   `system_settings` 启动 core/gateway，邮件、OAuth、webhook、LLM Provider
   仍为生产值，演练实例可能向 真实用户发信或调用外部上游。
3. **发布预检 / 自测包解压无限额**：`inspectEvaluationPackage` 直接
   `unzipSync(data)`， `oi-self-test-package.ts` 只有白名单 filter，zip bomb
   可撑爆内存。
4. **judge 注入 exec 无超时**：`dual/inject.rs` 中 `create_exec` / `start_exec`
   / `inspect_exec` 裸 await，Docker daemon 卡住时评测永久挂起。
5. **evaluator 帧级 `timeout_ms`
   绕过硬上限**：`InFlightTracker::resolve_timeout`
   接受任意正整数，`JUDGE_MAX_SOLUTION_CALL_TIMEOUT_MS` 只截断了题目级默认值。
6. **OAuth 登录不检查平台封禁**：密码登录拒绝 `USER_BANNED`，`issueOAuthSession`
   不查， 两条登录路径口径不一致（写操作仍被中间件拦截）。
7. **密钥掩码回显首尾字符**：`maskSecret` 保留前 3 后 3 字符，泄露密钥片段。

## Decision

1. 删除 `internal-llm-policy` 路由及测试（gateway 已不调用）；Nitro
   代理在规范化后的 pathname 上对
   `/api/v1/internal`（不区分大小写、容忍多斜杠、解码后再判定）直接 404； nginx
   增加 `location ^~ /api/v1/internal/ { return 404; }`。CLI 排空经
   `docker compose run core maintain` 直连 `http://core:8000`，不受影响。
2. 演练 env 末尾追加出站禁用段（`EMAIL_PROVIDER=disabled`、OAuth/云邮件凭据/
   `NOJ_LLM_GATEWAY_URL`/告警 webhook 置空）；core 启动前在隔离库执行禁用 SQL：
   `email_provider` 置 `"disabled"`、邮件凭据与 LLM 默认项置 `""`、键名像
   webhook 且值为 URL
   的设置清空、`llm_providers.enabled=false`。`system_settings.value` 为 JSON
   编码， SQL 写入带引号的值（已在本地 PostgreSQL 实测）。
3. `bundle-parser.ts` 新增 `unzipWithLimits`（条目数 / 单文件 / 总量 +
   路径穿越，解压后按 实际字节复核），预检与自测包解压统一走它。
4. inject.rs 三处 Docker 调用加 10s 超时（与 `container.rs` 一致）。
5. `InFlightTracker::new(default, max)`：帧值、cap_reg
   注册值与默认回退均按硬上限截断， 0 表示不限制（与 `clamp_runtime_config`
   语义一致）。
6. 抽出 `getActiveUserBan` / `isLoginBlockedByBan` /
   `assertLoginNotBanned`，密码登录与 OAuth 共用；OAuth 被拒时不写
   `auth.login_success`。
7. `maskSecret` 已配置时返回固定 `********`，未配置仍返回空串；UI 只依赖
   `is_secret` 与 `effective_value !== null`，不依赖掩码格式。

## Alternatives considered

- 内部端点只在 nginx 拦截：Nitro 代理是第二道边界，且 nginx 前缀匹配大小写敏感，
  两层都拦更稳妥。
- 演练只覆盖 env：`email_provider` 等 bootstrap 配置读取链为 DB → env → 默认值，
  快照 DB 值会遮蔽 env，必须同时改库。
- 审查中报告的其它中高危项（管理员重置密码不踢会话、gateway 全站额度按域放大、
  存储配额 TOCTOU、封榜快照泄露、设置页 If-Match
  无效、教学互动越权等）经核对为误报， 未改动。

## Consequences

- 公网访问 `/api/v1/internal/*` 一律 404；新增内部端点无需再单独考虑代理暴露。
- 演练实例不再具备真实出站能力；若 `alertmanager.yml` 在宿主机被渲染为字面量
  webhook， env 覆盖无法清除，需运维确认。
- `InFlightTracker::new` 签名变化，judge 内调用点与测试已同步。
- 后台设置页密钥统一显示 `********`，运维无法再凭首尾字符辨认是哪一把密钥。
