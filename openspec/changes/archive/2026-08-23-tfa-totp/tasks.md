## 1. 数据模型与环境变量

- [x] 1.1 在 `noj-core/src/db/schema.ts` 的 `users` 表新增 `tfa_secret_encrypted`（text nullable）和 `tfa_enabled`（boolean not null default false）
- [x] 1.2 在 `noj-core/src/db/schema.ts` 新增 `tfa_recovery_codes` 表（id、user_id、code_hash、used_at、created_at，user_id FK → users ON DELETE CASCADE，user_id 索引）
- [x] 1.3 使用 `deno task db:generate` 生成 Drizzle 迁移并检查 SQL
- [x] 1.4 在 `noj-core/.env.example`、`scripts/dev/env.example`、`env.e2e.template` 新增 `TFA_ENCRYPTION_KEY` 说明/示例值
- [x] 1.5 在 `noj-core/scripts/check-env.ts` 增加 `TFA_ENCRYPTION_KEY` 必填校验（≥32 字符）

## 2. TFA 核心库

- [x] 2.1 在 `noj-core/deno.json` 增加 `npm:otpauth` 依赖
- [x] 2.2 新建 `noj-core/src/lib/tfa.ts`：生成 TOTP secret、构造 `otpauth://` URL、TOTP 校验（±1 步）
- [x] 2.3 在 `tfa.ts` 实现 `TFA_ENCRYPTION_KEY` 派生 AES-256 密钥与 AES-256-GCM 加密/解密（IV + authTag）
- [x] 2.4 在 `tfa.ts` 实现恢复码生成（格式 `XXXX-XXXX-XXXX`，去除 `0/O/1/I`）与 SHA-256 哈希
- [x] 2.5 为 `tfa.ts` 编写单元测试：加解密往返、TOTP 校验、恢复码生成/哈希

## 3. TFA 服务层

- [x] 3.1 新建 `noj-core/src/services/tfa.ts`：`getTfaStatus` / `setupTfa` / `confirmTfa` / `disableTfa` / `regenerateRecoveryCodes`
- [x] 3.2 实现 `confirmTfa`：校验 TOTP、启用 `tfa_enabled`、生成 10 个恢复码并哈希入库、返回明文恢复码
- [x] 3.3 实现 `disableTfa`：校验 TOTP 或恢复码、清除 secret、删除恢复码、消费恢复码（如使用）
- [x] 3.4 实现 `regenerateRecoveryCodes`：校验 TOTP 或恢复码、作废旧码、生成新 10 个恢复码、消费恢复码（如使用）
- [x] 3.5 实现恢复码消费的原子更新（`used_at IS NULL` 条件更新，防并发重复使用）
- [x] 3.6 为 `services/tfa.ts` 编写服务层测试

## 4. 登录接入 TFA

- [x] 4.1 在 `noj-core/src/types/auth.ts` 的 `LoginInput` 增加可选 `code?: string`，`UserResponse` 增加 `tfa_enabled: boolean`
- [x] 4.2 修改 `noj-core/src/services/auth.ts` 登录逻辑：密码正确后若 `tfa_enabled` 则校验 `code`（TOTP 或恢复码）
- [x] 4.3 缺少 `code` 时抛 `BadRequestError` 且错误码 `TFA_REQUIRED`
- [x] 4.4 校验失败时计入现有登录失败限流并返回 401
- [x] 4.5 恢复码登录成功后消费该恢复码
- [x] 4.6 更新 `toUserResponse` 和所有构造用户响应的位置，携带 `tfa_enabled`
- [x] 4.7 为登录 TFA 分支编写路由/服务测试（缺 code、错误 TOTP、正确 TOTP、恢复码、已使用恢复码）

## 5. TFA 管理路由

- [x] 5.1 在 `noj-core/src/routes/auth.ts` 或新建 `routes/tfa.ts` 注册 `POST /api/v1/auth/tfa/setup`
- [x] 5.2 注册 `POST /api/v1/auth/tfa/confirm`
- [x] 5.3 注册 `POST /api/v1/auth/tfa/disable`
- [x] 5.4 注册 `POST /api/v1/auth/tfa/recovery-codes/regenerate`
- [x] 5.5 为 TFA 管理端点补充鉴权、参数校验、错误处理和限流
- [x] 5.6 编写路由测试覆盖 setup/confirm/disable/regenerate 的成功与失败路径

## 6. 审计日志

- [x] 6.1 在 TFA 服务层记录审计事件：`auth.tfa_setup`、`auth.tfa_enabled`、`auth.tfa_disabled`、`auth.tfa_recovery_regenerated`、`auth.tfa_recovery_used`
- [x] 6.2 确保审计日志不记录 secret / 恢复码明文

## 7. 前端登录页

- [x] 7.1 修改 `noj-ui/composables/useAuth.ts` 的 `login` 支持可选 `code`，并识别 `TFA_REQUIRED` 错误
- [x] 7.2 修改 `noj-ui/pages/login.vue`：首次提交密码后收到 `TFA_REQUIRED` 时显示“两步验证码”输入框
- [x] 7.3 登录页验证码输入框同时接受 TOTP 或恢复码，再次提交携带 `login + password + code`
- [x] 7.4 保持原有错误处理与强制改密跳转逻辑

## 8. 前端设置页

- [x] 8.1 在 `noj-ui/package.json` 增加 `qrcode` 依赖
- [x] 8.2 在 `noj-ui/pages/settings.vue` 新增“两步验证（TFA）”区块
- [x] 8.3 未启用状态：调用 setup 显示二维码（前端渲染 `otpauth_url`）和手动密钥，输入验证码后调用 confirm，展示恢复码
- [x] 8.4 已启用状态：显示“已启用”，提供“禁用”和“重新生成恢复码”操作（均需输入 TOTP/恢复码）
- [x] 8.5 复用现有 `useDialog` / `useToast` 交互模式

## 9. E2E 测试

- [x] 9.1 在 `noj-tests/e2e/` 新增 TFA E2E：注册用户 → 启用 TFA → 登出
- [x] 9.2 覆盖登录：密码正确但无 code → `TFA_REQUIRED`；错误 code → 拒绝；正确 TOTP → 成功
- [x] 9.3 覆盖恢复码登录：使用后该恢复码作废
- [x] 9.4 覆盖禁用 TFA：需验证码/恢复码确认
- [x] 9.5 覆盖重新生成恢复码：旧码作废、新码可用
- [x] 9.6 确保 E2E 环境变量包含 `TFA_ENCRYPTION_KEY`

## 10. 收尾

- [x] 10.1 运行 `deno fmt`、`deno lint`、`deno task check:types`（noj-core / noj-ui）
- [x] 10.2 运行 noj-core 全量测试与 noj-tests E2E
- [x] 10.3 更新相关文档（`noj-core/CLAUDE.md` / `noj-ui/CLAUDE.md` 如涉及 API/环境变量）
