## Context

NOJ 当前登录为单因素密码认证。用户表 `users` 只有 `password_hash` 等字段，没有
TFA 相关数据；登录接口 `POST /api/v1/auth/login` 直接返回 JWT。前端通过 Nitro
代理拦截登录响应并设置 HTTP-only Cookie。

本期引入 TOTP 二次验证，需要同时改动后端认证、数据模型、前端登录/设置页与测试。

## Goals / Non-Goals

**Goals:**

- 用户可自愿启用/禁用 TOTP。
- 已启用 TOTP 的用户登录时必须提供 6 位验证码或恢复码。
- 提供 10 个一次性恢复码，支持生成、使用、作废、重新生成。
- TOTP secret 加密存储，恢复码只存哈希。

**Non-Goals:**

- 不支持 WebAuthn / Passkey。
- 不做受信任设备跳过 TFA。
- 不做管理员强制全员 TFA。
- 不引入挑战令牌 / 两步接口：登录采用一次提交（密码 + 可选 code）。

## Decisions

### 1. 登录采用一次提交，不引入挑战令牌

`POST /api/v1/auth/login` 请求体增加可选 `code` 字段。密码正确后：

- 未启用 TFA：直接签发 JWT。
- 已启用 TFA：校验 `code`（TOTP 或恢复码），成功才签发 JWT；缺少 `code` 返回
  400 + `TFA_REQUIRED`。

**备选方案**：两步提交 + 短期挑战令牌。优点是 UI 更“标准”，但需要额外临时状态 /
Redis 票据，增加复杂度和攻击面。一次提交足够满足需求，前端可在收到
`TFA_REQUIRED` 后再展示验证码输入框，实现“密码正确后要求验证码”的体验。

### 2. TOTP 库使用 `npm:otpauth`

负责 secret 生成、otpauth URI 构造、TOTP 校验（30 秒步长，允许 ±1 步偏移）。

**备选方案**：手写 HMAC-SHA1 TOTP。可行但易出错，且 otpauth URI / base32 处理
需要额外代码；`otpauth` 是成熟库，Deno 可通过 npm: 直接使用。

### 3. TOTP secret 使用独立 `TFA_ENCRYPTION_KEY` 加密

- 新增环境变量 `TFA_ENCRYPTION_KEY`（≥32 字符）。
- SHA-256 派生 AES-256 密钥，AES-256-GCM 加密，密文含 IV + authTag。
- 与 `JWT_SECRET` 隔离，避免单一密钥泄露连带 TFA secret 泄露。

**备选方案**：从 `JWT_SECRET` 派生。部署简单，但密钥隔离性差。

### 4. 恢复码存 SHA-256 哈希

新增 `tfa_recovery_codes` 表，`code_hash` 存哈希，`used_at` 标记消费；原子更新
防止并发重复使用。恢复码格式 `XXXX-XXXX-XXXX`，去除 `0/O/1/I`。

### 5. 二维码前端生成

后端只返回 `otpauth_url`，前端新增 `qrcode` npm 依赖本地渲染。

**备选方案**：后端生成 Data URL。UI 更简单，但增加后端图片依赖，且 secret 多经过
一次服务端处理；前端生成更合适。

### 6. 管理端点放在已登录 API 下

新增 `POST /api/v1/auth/tfa/setup|confirm|disable|recovery-codes/regenerate`，
均需 `authMiddleware`。`GET /api/v1/auth/me` 增加 `tfa_enabled` 字段。

## Risks / Trade-offs

- [TFA_REQUIRED 暴露用户是否开启 TFA] → 这是登录流程需要的可接受信息；不额外暴露
  secret 或恢复码。
- [TOTP 暴力枚举] → 复用现有登录限流（账号/IP 维度）；TFA 管理端点对验证码失败也做
  限流。
- [Redis 不可用时登录限流不可用] → 现有登录已依赖 Redis 限流；TFA 不新增额外 Redis
  依赖。
- [恢复码泄露] → 只存哈希，明文仅生成时返回一次；重新生成后旧码全部作废。
- [用户丢失 TOTP 和恢复码] → 本期不提供找回机制；后续可考虑管理员重置或邮箱验证。

## Migration Plan

1. 添加 Drizzle 迁移：`users` 新列 + `tfa_recovery_codes` 表。
2. 新增 `TFA_ENCRYPTION_KEY` 到 `.env.example` / `scripts/dev/env.example` /
   `env.e2e.template`，并在 `check-env.ts` 增加校验。
3. 后端实现 TFA 库、服务、路由，接入登录分支。
4. 前端实现登录页 TFA 输入与设置页管理 UI。
5. 补充 noj-core 单元/路由测试与 noj-tests E2E。

**回滚策略**：迁移可安全回滚（新增列/表可删除）；若发布后出现问题，可先通过
`tfa/disable` 或数据库清理关闭个别用户 TFA；功能开关层面本期不新增。

## Open Questions

- 是否需要在管理后台提供“重置用户 TFA”能力？（本期未包含，可作为后续增强）
