## 1. 新增邮件 Provider 抽象层

- [x] 1.1 创建目录 `noj-core/src/lib/email-providers/`
- [x] 1.2 定义统一接口 `src/lib/email-providers/types.ts`，声明 `sendPasswordResetEmail(email, resetLink, expiresInMinutes): Promise<void>`
- [x] 1.3 将现有 `src/lib/email.ts` 改造为抽象入口，根据 `EMAIL_PROVIDER` 动态选择并导入 Provider，默认 fallback 到 mock
- [x] 1.4 将现有 console.log mock 实现迁移到 `src/lib/email-providers/mock.ts`

## 2. 接入阿里云 DirectMail Provider

- [x] 2.1 在 `noj-core/deno.json` 添加依赖 `@alicloud/dm20151123`
- [x] 2.2 实现 `src/lib/email-providers/aliyun.ts`，封装 `@alicloud/dm20151123` 调用
- [x] 2.3 在 `aliyun.ts` 中校验 `ALIBABA_ACCESS_KEY_ID`、`ALIBABA_ACCESS_KEY_SECRET`、`ALIBABA_FROM_EMAIL` 环境变量，缺失时抛出配置错误

## 3. 接入腾讯云 SES Provider

- [x] 3.1 在 `noj-core/deno.json` 添加依赖 `tencentcloud-sdk-nodejs-ses`
- [x] 3.2 实现 `src/lib/email-providers/tencent.ts`，封装 `tencentcloud-sdk-nodejs-ses` 调用
- [x] 3.3 在 `tencent.ts` 中校验 `TENCENT_SECRET_ID`、`TENCENT_SECRET_KEY`、`TENCENT_FROM_EMAIL`、`TENCENT_REGION` 环境变量，缺失时抛出配置错误

## 4. 启动校验与配置

- [x] 4.1 更新 `noj-core/.env.example`，增加邮件相关环境变量模板
- [x] 4.2 在 `main.ts` 中新增 `checkEmailProviderConfig()` 启动校验函数
- [x] 4.3 `checkEmailProviderConfig()` 行为：`EMAIL_PROVIDER=aliyun|tencent` 但缺少对应环境变量时，`console.warn` 并降级到 mock（不阻塞启动）
- [x] 4.4 更新 `noj-core/AGENTS.md`，说明邮件 Provider 的选择与配置方式
- [x] 4.5 检查 `passwordReset.ts` 调用方无需改动，确认 `await sendPasswordResetEmail(...)` 行为一致

## 5. 测试

- [x] 5.1 为 mock Provider 补充单元测试
- [x] 5.2 为阿里云 Provider 编写参数构造/环境变量校验的单元测试（mock SDK 返回值）
- [x] 5.3 为腾讯云 Provider 编写参数构造/环境变量校验的单元测试（mock SDK 返回值）
- [x] 5.4 运行 `deno task test`，确保密码重置相关路由/服务测试不受影响
- [x] 5.5 手动验证 `deno fmt` 与 `deno lint` 无新增问题

## 6. 验证与合并

- [ ] 6.1 在至少一个真实云账号（阿里云或腾讯云）下验证密码重置邮件能正常发送
- [ ] 6.2 更新 `openspec/changes/add-email-provider` 任务清单，标记完成项
- [ ] 6.3 通过 PR 提交代码，关联 issue #49 / PR #72
