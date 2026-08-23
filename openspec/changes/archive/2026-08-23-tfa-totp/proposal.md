## Why

NOJ 当前只有密码认证，缺少第二因素；账号密码一旦泄露即可完全接管。引入 TOTP
二次验证可显著提升账号安全，对齐 HydroOJ 已具备的 2FA 能力。

## What Changes

- 新增 TOTP 二次验证：用户可在设置页启用/禁用，启用后登录必须提供 6 位验证码或恢复码。
- 新增 10 个一次性恢复码：生成、使用、作废、重新生成；恢复码只存哈希。
- `users` 表新增 `tfa_secret_encrypted`、`tfa_enabled` 字段，新增 `tfa_recovery_codes` 表。
- 登录接口 `POST /api/v1/auth/login` 支持可选 `code` 字段：已启用 TFA 的用户缺少或提交错误验证码时登录失败。
- 设置页新增 TFA 管理 UI：二维码、手动密钥、验证码确认、恢复码展示与重新生成。
- 新增环境变量 `TFA_ENCRYPTION_KEY`，用于加密存储 TOTP secret。

## Capabilities

### New Capabilities

- `tfa-management`: 用户启用/禁用 TOTP、生成/重新生成恢复码、查看 TFA 状态。

### Modified Capabilities

- `user-auth`: 登录流程增加 TFA 校验分支，`UserResponse` 增加 `tfa_enabled` 字段。

## Impact

- **noj-core**：`src/db/schema.ts`、Drizzle 迁移、`src/lib/tfa.ts`、`src/services/tfa.ts`、`src/services/auth.ts`、`src/routes/auth.ts`、`src/types/auth.ts`、环境变量校验。
- **noj-ui**：`pages/login.vue`、`pages/settings.vue`、`composables/useAuth.ts`、新增 `qrcode` 依赖。
- **测试**：noj-core 单元/路由测试、noj-tests E2E。
- **依赖**：noj-core 新增 `npm:otpauth`；noj-ui 新增 `qrcode`。
