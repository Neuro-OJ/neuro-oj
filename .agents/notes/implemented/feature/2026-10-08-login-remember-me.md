# Agent Note: 登录增加「记住我」选项

Status: implemented

## Problem

用户反馈每天都要重新登录。JWT 固定 24h（`jwt_expires_in`），且没有续期机制；noj-ui 代理写入
`noj:token` / `noj:session` Cookie 时又硬编码 `maxAge: 24h`（审计 NOJ-222），即使调大
`JWT_EXPIRES_IN`，Cookie 也会先于 token 过期。

此外 `/logout`、`/change-password` 撤销旧 jti 时 Redis TTL 固定 24h：一旦 token 有效期超过
24h，撤销条目会先于 token 过期，被登出的 token 会「复活」。

## Decision

- 登录请求体新增可选 `remember`（仅严格 `true` 生效）。勾选时 `signToken` 改用新的 runtime 设置
  `jwt_remember_expires_in`（env `JWT_REMEMBER_EXPIRES_IN`，默认 `30d`）；未勾选维持 `jwt_expires_in`。
- `verifyToken` 返回 `exp`，认证中间件写入上下文 `tokenExp`：
  - 登出 / 改密撤销旧 jti 的 TTL 改为 token 剩余有效期（无 exp 的历史 token 回退 24h）；
  - 改密换发新 token 时通过 `expiresAt` 沿用旧 token 的 exp，保持会话时长不变。
- noj-ui 代理按 JWT payload 的 `exp` 计算 Cookie `maxAge`（`cookieMaxAgeFromJwt`），解析失败回退 24h，
  使 Cookie 与 token 同步过期，顺带修复 NOJ-222。
- 登录页在密码下方增加「记住我」复选框，并提示共享设备勿勾选；TFA 二次提交沿用同一勾选值。
- OAuth 登录未接入「记住我」，维持默认有效期。

## Alternatives considered

- **Refresh token / 滑动续期**：体验更好，但需新增 refresh 存储、轮换与撤销语义，改动面远大于需求。
- **直接调大 `jwt_expires_in`**：所有会话（含共享设备）都变长，且 Cookie 硬编码问题仍在。
- **未勾选时改用会话 Cookie（关闭浏览器即失效）**：更贴近部分站点语义，但会改变现有用户的默认体验，暂不采用。

## Consequences

- 勾选「记住我」的会话最长 30 天有效；被盗 token 的有效窗口相应变长，仍可通过登出、改密
  （session_version）、封禁即时失效。
- 新增设置项需在 `.env.example`、`.env.prod.example`、`docker-compose.prod.yml` 中同步（已完成）。
- 撤销条目在 Redis 中的保留时间最长等于 30 天，条目数量与登出次数线性相关，开销可忽略。
