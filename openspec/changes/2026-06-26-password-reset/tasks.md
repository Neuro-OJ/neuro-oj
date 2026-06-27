# 密码重置 — 实施任务

## 1. OpenSpec 提案

- [x] 1.1 创建 `openspec/changes/2026-06-26-password-reset/proposal.md`（背景 + What Changes + Impact）
- [x] 1.2 创建 `openspec/changes/2026-06-26-password-reset/design.md`（安全模型 + 数据流 + 关键 SQL + Mock runbook）
- [x] 1.3 创建 `openspec/changes/2026-06-26-password-reset/.openspec.yaml`（change 元信息）
- [x] 1.4 创建 `openspec/changes/2026-06-26-password-reset/specs/user-auth/spec.md`（delta）
- [x] 1.5 创建 `openspec/changes/2026-06-26-password-reset/specs/database-schema/spec.md`（delta）

## 2. noj-core：DB schema + 迁移

- [ ] 2.1 `noj-core/src/db/schema.ts` 追加 `passwordResetTokens` 表
- [ ] 2.2 `noj-core/drizzle/0007_password_reset_tokens.sql` 新建（CREATE TABLE + 索引）
- [ ] 2.3 `noj-core/drizzle/meta/_journal.json` 追加 idx=7

## 3. noj-core：Lib 工具

- [ ] 3.1 `noj-core/src/lib/resetToken.ts` 新建（generate + hash）
- [ ] 3.2 `noj-core/src/lib/email.ts` 新建（mock sendPasswordResetEmail）

## 4. noj-core：Service + Route

- [ ] 4.1 `noj-core/src/types/auth.ts` 追加 ForgotPasswordInput / ResetPasswordInput
- [ ] 4.2 `noj-core/src/services/passwordReset.ts` 新建（requestReset + resetPassword）
- [ ] 4.3 `noj-core/src/routes/auth.ts` 追加 POST /forgot-password + POST /reset-password

## 5. noj-core：测试

- [ ] 5.1 `noj-core/tests/services/passwordReset.test.ts` 新建（8 个用例）
- [ ] 5.2 `noj-core/tests/routes/auth.test.ts` 追加（端到端 200/400）

## 6. noj-core：AGENTS.md

- [ ] 6.1 `noj-core/AGENTS.md` 追加密码重置安全约定（防枚举、15 分钟 TTL、哈希存 token）

## 7. noj-ui：useAuth + middleware

- [ ] 7.1 `noj-ui/composables/useAuth.ts` 追加 forgotPassword/resetPassword
- [ ] 7.2 `noj-ui/middleware/auth.ts` 加白名单 forgot-password/reset-password

## 8. noj-ui：页面

- [ ] 8.1 `noj-ui/pages/forgot-password.vue` 新建（仿 login.vue 模式）
- [ ] 8.2 `noj-ui/pages/reset-password.vue` 新建（仿 register.vue 模式）
- [ ] 8.3 `noj-ui/pages/login.vue` 改动（删 showForgot 弹窗，链到 forgot-password，读 query.reset banner）

## 9. noj-ui：AGENTS.md

- [ ] 9.1 `noj-ui/AGENTS.md` 追加密码重置页面约定

## 10. 验证 + 提交

- [ ] 10.1 `cd noj-core && deno task fmt && deno task lint && deno task test` 全过
- [ ] 10.2 `cd noj-core && deno task migrate` 验证 0007 迁移成功
- [ ] 10.3 端到端 curl 验证三个核心场景（已注册邮箱、合法 token 重置、未注册邮箱防枚举）
- [ ] 10.4 提交 + GPG 签名 + push + 创建 PR
