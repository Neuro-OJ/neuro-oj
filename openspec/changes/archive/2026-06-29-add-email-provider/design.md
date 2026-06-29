## Context

PR #72 在 `noj-core/src/lib/email.ts` 中实现了一个 `console.log` 的 mock 邮件发送函数，用于完成密码重置流程。当前实现仅适用于开发和测试环境，无法在生产环境真实投递邮件。

为了支持生产环境，需要引入一个可插拔的邮件 Provider 抽象层，允许部署者根据所在云环境（阿里云或腾讯云）选择对应的邮件推送服务，同时保留 mock 模式供本地开发和 CI/E2E 使用。

## Goals / Non-Goals

**Goals:**
- 为 `sendPasswordResetEmail()` 提供统一的抽象入口，调用方无需关心底层 Provider。
- 支持阿里云 DirectMail 与腾讯云 SES 两种国内可直连的云邮件服务。
- 保留 mock Provider 作为默认行为，保证未配置环境时项目仍可运行。
- 通过环境变量切换 Provider，配置简单明确。
- Provider 初始化失败时给出清晰错误，不影响 mock 模式下的启动。

**Non-Goals:**
- 不引入 SMTP 自建方案（端口/信誉维护成本高，本期不纳入）。
- 不扩展邮件类型以外的用途（如营销邮件、批量邮件）。
- 不修改用户认证和密码重置的对外 API 行为。
- 不引入邮件模板系统；HTML 内容在 Provider 内部临时构造。

## Decisions

### 1. 环境变量配置与三层校验

- **选择**：配置项全部放在 `.env` 文件中，沿用现有模式。新增 `main.ts` 启动期校验 + Provider 调用时二次校验 + 默认 mock 兜底的三层防护。
- **理由**：
  - 邮件服务不是核心依赖，缺失时不应阻塞启动。Redis 连接失败尚可 degraded 模式运行，邮件更应如此。
  - 启动期校验发现配置缺失时降级到 mock 并 `console.warn`，而非 `Deno.exit(1)`。
  - Provider 调用时再做一次校验（`throw`），防止启动后配置变更导致静默失败。
- **环境变量命名**：云厂商自己的 SDK 用 `ALIBABA_` / `TENCENT_` 前缀，与项目通用的 `NOJ_` 区分——这样环境变量名和 SDK 文档一致，降低配错概率。
- **替代方案**：统一用 `NOJ_EMAIL_*` 前缀再映射到 SDK 参数。优点是命名统一，缺点是增加了心智负担（得查映射表才知道对应哪个云厂商的什么参数）。

### 2. 使用官方 Node.js SDK 而非手写签名

- **选择**：阿里云使用 `@alicloud/dm20151123`，腾讯云使用 `tencentcloud-sdk-nodejs-ses`。
- **理由**：签名逻辑由云厂商维护，降低集成错误风险；E2E 测试无法覆盖真实发送链路，手写签名更容易出 bug。
- **替代方案**：手写 `fetch + HMAC/TC3` 签名。优点是无 npm 依赖，缺点是维护成本高、SDK 升级需同步跟进。

### 2. Provider 目录 + 动态导入

- **选择**：在 `noj-core/src/lib/email-providers/` 下放置 `mock.ts`、`aliyun.ts`、`tencent.ts`，`email.ts` 根据 `EMAIL_PROVIDER` 动态导入对应文件。
- **理由**：避免启动时加载未使用的 SDK；未配置阿里云/腾讯云密钥时，不会触发对应 SDK 的导入。
- **替代方案**：所有 Provider 静态导入后 switch。优点代码直观，缺点 mock 模式下也会解析 npm 包，启动稍慢。

### 3. 默认 mock，显式启用真实 Provider

- **选择**：`EMAIL_PROVIDER` 未设置或为空时，默认使用 mock。
- **理由**：降低本地开发和测试的门槛；避免未配置密钥时意外调用真实 API。
- **替代方案**：默认直接启用某个 Provider。会导致未配置 AK 时启动失败或报错。

### 4. SDK 返回 Promise，调用方统一 `await`

- **选择**：`sendPasswordResetEmail` 定义为 `async`，所有 Provider 返回 `Promise<void>`。
- **理由**：与现有 `passwordReset.ts` 中的 `await sendPasswordResetEmail(...)` 调用方式一致，无需修改调用方。

### 5. Provider 级别校验：发送前检查必要环境变量

- **选择**：每个真实 Provider 在 `send` 函数被调用时检查 AK/发信地址等环境变量，缺失则抛出配置错误。
- **理由**：避免在 `email.ts` 顶层做复杂校验；未启用某 Provider 时其环境变量缺失也不会报错。

## Risks / Trade-offs

- **[Risk] npm SDK 在 Deno 下的兼容性**：两个 SDK 均为 Node.js 设计，依赖 `node:crypto` 等内置模块。
  - **Mitigation**：项目已启用 `"nodeModulesDir": "auto"` 且大量使用 `npm:` 导入；在实现后通过 `deno task test` 和手动 `deno run` 验证。如存在兼容性问题，回退到手写签名方案。

- **[Risk] 腾讯云 SES SDK 包体积较大**：完整版 SDK 包含所有产品，但可用 `tencentcloud-sdk-nodejs-ses` 仅安装 SES。
  - **Mitigation**：锁定使用 `tencentcloud-sdk-nodejs-ses` 专用包，不引入全产品 SDK。

- **[Risk] 发信域名未经验证导致真实发送失败**：云厂商要求先验证发信域名并配置 SPF/DKIM。
  - **Mitigation**：文档中明确说明生产环境需先在控制台验证域名；单元测试不验证真实发送，仅验证参数构造。

- **[Risk] 未使用的 Provider SDK 仍会被 Deno 缓存**：即使 `EMAIL_PROVIDER=mock`，Deno 仍可能下载并缓存 npm 包元数据。
  - **Mitigation**：这是 Deno npm 导入的正常行为，不影响运行；可在 CI 中通过 `--node-modules-dir=false` 或条件化依赖进一步优化。

## Migration Plan

1. **开发/测试环境**：无需变更，`EMAIL_PROVIDER` 不填即可继续使用 mock。
2. **生产环境（阿里云）**：
   - 在阿里云控制台验证发信域名并配置 SPF/DKIM。
   - 在 `.env` 中设置：
     ```env
     EMAIL_PROVIDER=aliyun
     ALIBABA_ACCESS_KEY_ID=xxx
     ALIBABA_ACCESS_KEY_SECRET=xxx
     ALIBABA_FROM_EMAIL=noreply@neuro-oj.com
     ```
3. **生产环境（腾讯云）**：
   - 在腾讯云 SES 控制台验证发信域名并配置 SPF/DKIM。
   - 在 `.env` 中设置：
     ```env
     EMAIL_PROVIDER=tencent
     TENCENT_SECRET_ID=xxx
     TENCENT_SECRET_KEY=xxx
     TENCENT_FROM_EMAIL=noreply@neuro-oj.com
     TENCENT_REGION=ap-guangzhou
     ```
4. **回滚**：将 `EMAIL_PROVIDER` 改回 `mock` 或清空，即可恢复控制台输出，无需代码改动。

## Open Questions

- 是否需要支持同时配置多个 Provider 并按优先级 fallback？（本期建议不支持，保持简单）
- 是否需要把邮件内容模板抽离到独立文件？（本期建议不抽离，密码重置 HTML 直接在 Provider 内构造）
