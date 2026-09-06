# Agent Note: 修复注册 sent 作用域并统一邮件就绪注册门槛（issue #425 / #426）

Status: implemented

## Problem

- **#425**：`noj-ui/pages/register.vue` 在注册 try 块内声明 `const sent`，自动登录成功后引用该变量抛
  ReferenceError，被外层 catch 误判为登录失败，跳到 `/login?registered=1`，误导已成功登录的用户。
  根因之一是 noj-ui 的类型检查任务（`deno check utils tests`）不覆盖 pages，此类未定义变量无法被发现。
- **#426**：生产允许 `EMAIL_PROVIDER=disabled`，站点可启动，但新账号 `email_verified=false` 而提交、
  社区、私信写操作要求先验证邮箱，形成"注册成功但无法完成验证及主要功能"的死路；
  文档仅提示密码找回受影响，管理后台与注册入口均无受限提示。

## Decision

**#425（UI）**

1. 将"注册 → 自动登录 → 跳转"流程抽为纯函数 `noj-ui/utils/registerFlow.ts`（`submitRegistration`），
   `sent` 在整个流程作用域内；register.vue 改为调用该函数。
   流程逻辑因此进入 `deno task check:types` 的检查范围，此类作用域错误今后会被类型检查捕获。
2. 新增 `noj-ui/tests/registerFlow_test.ts` 回归测试，覆盖 sent=1 / sent=0 / 登录失败 / 注册失败四个分支。

**#426（core + UI + docs）**

1. 新增 `noj-core/src/domains/system/services/email-status.ts`：`getEmailConfigStatus()` 统一回答邮件是否
   就绪（disabled=未就绪；mock 仅非生产就绪；aliyun/tencent 必需配置齐全才就绪）。必需配置清单
   `EMAIL_PROVIDER_REQUIRED_SETTINGS` 提取到 `shared/config/production-config.ts` 与生产校验共享，避免漂移。
2. 注册门槛：`POST /register` 在 allow_register 之外增加第二道死开关——邮件未就绪且站点已有真实用户时
   返回 403 `REGISTER_EMAIL_UNCONFIGURED`；保留站点引导阶段的首次注册（成为管理员），避免全新安装死锁。
3. 新增公开端点 `GET /api/v1/auth/register-status`（返回 allowed + reason），注册页渲染前感知受限状态并
   展示横幅、禁用表单；`POST /email/resend` 返回 `sent` 布尔值，前端对临时失败给出准确提示。
4. 管理端：`GET /api/v1/admin/settings/email/status` + `POST /api/v1/admin/settings/email/test-send`
   （`sendTestEmail`），管理后台「系统设置」展示就绪横幅并支持发送测试邮件。
5. 启动摘要：main.ts 启动时输出邮件就绪状态，未就绪时 warn 说明公开注册被禁止及缺失配置项。
6. 验证页增加"重新发送验证邮件"入口（sent=0 时主按钮展示）。
7. 文档：production-deploy.md、admin-guide.md 更新 disabled 的真实语义与开放注册前检查步骤。

## Alternatives considered

- **未配置邮件时跳过邮箱校验（放行写操作）**：会削弱既有邮箱验证策略（issue 采纳方明确不建议），否决。
- **仅在前端隐藏注册入口**：可被绕过，门槛必须在服务端强制；前端横幅只作体验层。
- **未就绪时直接禁止全部注册（含首个用户）**：全新安装无法创建第一个管理员，形成新死路，否决；
  以"无真实用户时放行"保留引导路径。
- **在 register.vue 内联修复 `sent` 作用域**：修复本身一行即可，但页面逻辑仍无类型检查与回归测试覆盖，
  抽出纯函数一并解决验收标准中"完整类型检查能发现此类未定义变量"的诉求。

## Consequences

- 邮件未配置的生产站点升级后，公开注册会从"可用但死路"变为"明确禁止（403 + 前端受限横幅）"，
  运营者需配置邮件并测试后才能开放注册——这是本 issue 的预期行为变更。
- `/email/resend` 响应新增 `sent` 字段（向后兼容，旧字段保留）；已登录用户可感知发送结果，不泄露他人状态。
- mock Provider 在生产环境仍视为未就绪，与 email.ts 现有"生产禁止 mock 发送"约束一致。
- 已知无关回归：`catalog/tests/routes/trainings.test.ts` 2 个用例因测试环境缺 JWT_SECRET 失败，
  在基线提交 de6fd665 上同样失败（预先存在）。
