# TFA TOTP 二次验证设计

> 对应 issue：https://github.com/Neuro-OJ/neuro-oj/issues/228
> 日期：2026-08-19
> 状态：已与需求方确认设计，待评审

## 1. 背景与目标

NOJ 当前只有密码认证（bcrypt cost 12 + 强度校验），缺少第二因素。本设计引入
**TOTP（基于时间的一次性密码）二次验证**，对标 HydroOJ 的 2FA 能力。

本期范围：

- 支持 TOTP 验证器 App（Google Authenticator / Authy 等）。
- 支持 10 个一次性恢复码，生成 / 使用 / 作废 / 重新生成。
- 设置页提供 TFA 管理（二维码、手动密钥、验证码确认、恢复码展示）。
- 登录时已启用 TFA 的用户必须提供第二因素。

本期明确不做：

- WebAuthn / Passkey（后续单独提案）。
- 受信任设备跳过 TFA（后续增强）。
- 管理员强制全员开启 TFA（保持用户自愿开启）。

## 2. 关键决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 登录流程 | 一次提交：`login + password + code?` | 不需要挑战令牌 / 临时状态，实现最简单；前端可先提交密码，收到 `TFA_REQUIRED` 后再显示验证码输入框，体验仍符合“密码正确后要求验证码” |
| 挑战令牌 | 不需要 | 因为采用一次提交，TOTP 校验与密码校验在同一次请求完成 |
| 受信任设备 | 本期不做 | 保持每次登录都要求第二因素，安全模型简单 |
| TOTP 库 | `npm:otpauth` | 成熟、支持 TOTP 生成 / 校验 / otpauth URI |
| 二维码 | 前端生成 | 后端只返回 `otpauth_url`，前端用 `qrcode` npm 依赖本地渲染 |
| Secret 加密 | 独立 `TFA_ENCRYPTION_KEY` | 与 JWT_SECRET 隔离，避免 JWT 泄露连带 TFA secret 泄露 |
| 恢复码存储 | SHA-256 哈希，不存明文 | 沿用 `password_reset_tokens` 的 hash 模式 |
| 第二因素输入 | 统一输入框 | 同一个输入框接受 6 位 TOTP 或恢复码，后端自动区分 |

## 3. 数据模型

### 3.1 `users` 表新增列

| 列 | 类型 | 说明 |
|----|------|------|
| `tfa_secret_encrypted` | `text` nullable | TOTP secret 加密后的密文；未设置时为 `NULL` |
| `tfa_enabled` | `boolean` not null default `false` | 是否已启用 TFA |

### 3.2 新增 `tfa_recovery_codes` 表

| 列 | 类型 | 说明 |
|----|------|------|
| `id` | `text` PK | UUID |
| `user_id` | `text` not null FK → users | 级联删除 |
| `code_hash` | `text` not null | 恢复码的 SHA-256 哈希 |
| `used_at` | `text` nullable | 使用时间；`NULL` = 未使用 |
| `created_at` | `text` not null | 创建时间 |

约束/索引：

- `user_id` 上建索引，用于按用户查询恢复码。
- 一个用户同时最多存在 10 个未使用恢复码（应用层保证）。

### 3.3 加密方案

- 新增环境变量 `TFA_ENCRYPTION_KEY`，要求 ≥32 字符。
- 用 `SHA-256(TFA_ENCRYPTION_KEY)` 派生 AES-256 密钥。
- 对 TOTP secret 使用 AES-256-GCM 加密，密文存储格式：
  `base64(iv) + "." + base64(ciphertext + authTag)` 或等价结构。
- 在 `.env.example`、`scripts/dev/env.example`、`check-env.ts` 中补充该变量。

## 4. 登录流程

`POST /api/v1/auth/login` 请求体：

```json
{
  "login": "用户名或邮箱",
  "password": "密码",
  "code": "123456"
}
```

`code` 为可选字段，用于 TFA 验证码或恢复码。

服务端逻辑：

```
1. 查找用户，验证密码（原有逻辑，失败统一 401）
2. IP / 用户封禁检查（原有逻辑）
3. 若用户未启用 TFA：
     直接签发 JWT，返回 { user, token }
4. 若用户已启用 TFA：
     a. code 缺失或为空 → 400，错误码 TFA_REQUIRED
     b. code 为 6 位数字 → 校验 TOTP
     c. code 为恢复码 → 校验恢复码哈希并原子标记已使用
     d. 校验失败 → 401，计入登录失败限流
     e. 校验通过 → 签发 JWT，返回 { user, token }
```

注意事项：

- `TFA_REQUIRED` 使用 400 返回，前端据此展开“两步验证码”输入框。
- 密码错误 / TFA 错误统一不泄露“该用户是否开启 TFA”之外的额外信息；但
  `TFA_REQUIRED` 本身会暴露用户已开启 TFA，这是登录流程需要的可接受信息。
- TOTP 校验允许 ±1 个时间步长（30 秒）的时钟偏移。
- 登录成功审计沿用 `auth.login_success`；新增 TFA 相关审计事件（见下）。

## 5. TFA 管理 API

以下端点均需登录（`authMiddleware`）。

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/v1/auth/tfa/setup` | 生成新 TOTP secret，返回 `{ secret, otpauth_url }`；若已启用则 400；若未启用但已有旧 secret，则覆盖旧 secret |
| `POST` | `/api/v1/auth/tfa/confirm` | 请求体 `{ code }`；校验 6 位码，成功后启用 TFA 并生成 10 个恢复码，**仅此一次**返回 `{ recovery_codes }` |
| `POST` | `/api/v1/auth/tfa/disable` | 请求体 `{ code }`；接受 TOTP 或恢复码；成功后清空 secret 和恢复码 |
| `POST` | `/api/v1/auth/tfa/recovery-codes/regenerate` | 请求体 `{ code }`；接受 TOTP 或恢复码；作废旧码并生成新的 10 个恢复码 |
| `GET` | `/api/v1/auth/me` | 响应增加 `tfa_enabled` 字段（仅本人/登录态可见） |

`otpauth_url` 格式：

```
otpauth://totp/NeuroOJ:<username>?secret=<BASE32_SECRET>&issuer=NeuroOJ
```

### 5.1 启用流程

1. 用户点击“启用” → `POST /tfa/setup`
   - 生成随机 TOTP secret，加密后写入 `users.tfa_secret_encrypted`
   - `tfa_enabled` 仍为 `false`
   - 返回 `{ secret, otpauth_url }`
2. 前端显示二维码 / 手动密钥，用户输入 6 位码 → `POST /tfa/confirm`
   - 若之前未调用 setup 或 secret 不存在 → 400
   - 校验通过 → `tfa_enabled = true`
   - 生成 10 个恢复码，哈希后写入 `tfa_recovery_codes`
   - 返回明文恢复码（仅此一次）
3. 前端提示用户保存恢复码

### 5.2 禁用流程

- 用户点击“禁用” → 输入 TOTP 或恢复码 → `POST /tfa/disable`
- 校验通过后：
  - `tfa_enabled = false`
  - `tfa_secret_encrypted = null`
  - 删除该用户全部恢复码

### 5.3 恢复码规则

- 每个恢复码只能使用一次（`used_at IS NULL` 且原子更新防止并发重复使用）。
- 使用恢复码登录成功后，该码立即作废。
- 恢复码也可用于禁用 TFA / 重新生成恢复码；这些场景下使用恢复码同样会消费该码。
- 重新生成时，旧的未使用恢复码全部作废。
- 恢复码格式固定为 `XXXX-XXXX-XXXX`：3 组大写字母/数字，每组 4 位，使用去除了 `0/O/1/I` 的字符集（如 `ABCD-EFGH-JKLM`），生成时用密码学安全随机数。

## 6. 前端改动

### 6.1 登录页 `noj-ui/pages/login.vue`

- 表单新增“两步验证码”输入框，默认隐藏。
- 首次提交只带 `login + password`：
  - 成功 → 原逻辑（跳转首页 / 强制改密）。
  - 返回 `TFA_REQUIRED` → 显示验证码输入框，保留已填写的登录名和密码。
- 用户填入验证码后再次提交，请求体带 `login + password + code`。
- 输入框同时接受 6 位 TOTP 或恢复码。
- `useAuth.login` 增加对 `TFA_REQUIRED` 的处理（返回 `{ tfaRequired: true }` 或抛出带 code 的错误，由页面决定 UI）。

### 6.2 设置页 `noj-ui/pages/settings.vue`

新增“两步验证（TFA）”区块：

- 未启用：
  - “启用”按钮 → 调 `POST /tfa/setup`
  - 展示二维码（前端 `qrcode` 渲染 `otpauth_url`）+ 手动密钥
  - 输入 6 位码 → `POST /tfa/confirm`
  - 成功 → 展示 10 个恢复码（一次性），提示用户保存
- 已启用：
  - 显示“已启用”
  - “禁用”按钮 → 弹窗输入 TOTP / 恢复码 → `POST /tfa/disable`
  - “重新生成恢复码”按钮 → 弹窗输入 TOTP / 恢复码 → `POST /tfa/recovery-codes/regenerate` → 展示新恢复码

### 6.3 Nitro 代理

- 登录端点保持现有拦截逻辑：只有响应中出现 `data.token` 时才设置 Cookie。
- 一次提交流程中，TFA 校验失败返回 `TFA_REQUIRED` 时没有 `token`，代理不会设置 Cookie，行为无需额外改动。
- 确认没有新增需要拦截的认证端点（`/tfa/confirm`、`/tfa/disable` 等都在已登录状态调用，不需要写 Cookie）。

## 7. 后端模块划分

| 文件 | 职责 |
|------|------|
| `src/lib/tfa.ts` | TOTP secret 生成、加密/解密、otpauth URL 构造、TOTP 校验、恢复码生成/哈希 |
| `src/services/tfa.ts` | TFA 业务：setup / confirm / disable / regenerate、恢复码消费 |
| `src/routes/tfa.ts` 或并入 `routes/auth.ts` | TFA 管理路由 |
| `src/types/auth.ts` | `LoginInput` 增加 `code?`；`UserResponse` 增加 `tfa_enabled`；新增 TFA 相关类型 |
| `src/db/schema.ts` | users 新列 + `tfa_recovery_codes` 表 |
| `src/services/auth.ts` | 登录逻辑增加 TFA 校验分支 |

## 8. 安全设计

- TOTP secret 使用独立密钥加密存储，日志中不得输出明文 secret / 恢复码。
- 恢复码只存 SHA-256 哈希；明文只在生成时返回一次。
- 恢复码使用密码学安全随机数生成。
- 登录 TFA 校验失败复用现有登录限流（账号/IP 维度），防止暴力枚举 TOTP。
- `tfa/disable` 和 `tfa/recovery-codes/regenerate` 也应对验证码失败做限流，避免已登录会话被暴力尝试。
- 审计日志新增：
  - `auth.tfa_setup`（生成 secret）
  - `auth.tfa_enabled`（启用成功）
  - `auth.tfa_disabled`（禁用成功）
  - `auth.tfa_recovery_regenerated`（重新生成恢复码）
  - `auth.tfa_recovery_used`（恢复码登录成功）

## 9. 测试计划

### 9.1 noj-core 单元/路由测试

- `lib/tfa`：TOTP secret 生成、加密解密往返、TOTP 校验（含时间偏移）、恢复码生成/哈希。
- `services/tfa`：setup / confirm / disable / regenerate 业务规则。
- `routes/auth`：登录 TFA 分支：
  - 未开 TFA 用户登录行为不变。
  - 已开 TFA 缺 code → `TFA_REQUIRED`。
  - 错误 TOTP / 恢复码 → 401。
  - 正确 TOTP / 恢复码 → 登录成功。
- 恢复码一次性：使用后再次使用失败。
- `routes/tfa`：管理端点鉴权、已启用时 setup 拒绝、confirm 后返回恢复码、disable 需验证。

### 9.2 noj-tests E2E

- 注册用户 → 启用 TFA → 登出。
- 登录：密码正确但无 code → 提示 TFA；错误 code → 拒绝；正确 TOTP → 成功。
- 使用恢复码登录 → 成功且该恢复码作废。
- 禁用 TFA 需要验证码/恢复码确认。
- 重新生成恢复码后旧码作废。

## 10. 环境变量

新增：

```
TFA_ENCRYPTION_KEY=                    # 必填，≥32 字符，用于加密 TOTP secret
```

需要同步更新：

- `noj-core/.env.example`
- `scripts/dev/env.example`
- `scripts/check-env.ts` 校验逻辑
- `env.e2e.template`（E2E 环境提供固定测试密钥）

## 11. 后续可选增强（不在本期）

- 受信任设备跳过 TFA（签名 Cookie / 设备表）。
- WebAuthn / Passkey。
- 管理员强制策略或按角色要求 TFA。
- TFA 启用前强制二次确认（当前 confirm 已覆盖）。
