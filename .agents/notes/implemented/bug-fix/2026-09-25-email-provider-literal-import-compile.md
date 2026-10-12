# Agent Note: 邮件 Provider 动态导入改为字面量说明符（deno compile 内联）

Status: implemented

## Problem

`noj-server:0.10.1-alpha.2` 生产部署后，**所有发信链路
500**：管理后台「发送测试邮件」、
注册邮箱验证、找回密码全部失败，核心日志只有一行：

```text
TypeError: Module not found:
file:///tmp/deno-compile-noj-server/src/domains/system/services/email-providers/aliyun.ts
```

`src/domains/system/services/email.ts` 的装配点把 Provider
映射成**路径字符串**再 `await import(modulePath)`：

```ts
const PROVIDER_MODULES: Record<string, string> = { aliyun: "./email-providers/aliyun.ts", ... };
const mod = await import(modulePath);   // 变量说明符
```

`deno compile` 只对**字面量**动态导入做静态分析（literal dynamic
import）并把模块内联进
单文件二进制。变量说明符编译期不报错、不告警，产物里既不包含该模块、也没有回退分支——
运行到那一行才抛 `Module not found`，且路径指向产物解包目录
（`/tmp/deno-compile-noj-server/...`），与源码路径无关。

这类缺陷的隐蔽性在于**所有非生产路径都是绿的**：

- `deno task dev` 直接跑源码，动态导入按源文件路径解析，正常；
- 单元/集成测试同样跑源码，正常；
- CI 不执行编译产物中的该分支，正常；
- 只有生产镜像是 `deno compile` 产物 —— 故障只在生产出现，且表现为"模块丢失"
  而非配置错误，容易误判为 `.env` / Provider 配置问题（本次排查中确实先怀疑了
  `ALIBABA_*` 环境变量与发信地址）。

同源风险不止邮件：`storage/factory.ts`（`await import("./s3.ts")`）与
`content-review/providers/tencent.ts`（多行字面量
`import("npm:...")`）都用动态导入做
惰性装配，只是**恰好写了字面量**才在生产可用——即该写法本身没有门禁保护。

## Decision

1. **装配点改为字面量加载器**：`PROVIDER_MODULES`（路径表）替换为
   `PROVIDER_LOADERS`（`() => import("./email-providers/x.ts")`
   函数表），保持惰性加载与 `resetEmailProvider()` 语义不变；每个 Provider
   模块以 `EmailProviderModule` 接口约束， 顺带消除了原来的 `sendFn!`
   非空断言。`verify-capability-seams.ts` 的装配点白名单
   （`domains/system/services/email.ts`）同时匹配静态与动态导入，规则不受影响。
2. **新增仓库级门禁 `scripts/verify-compile-safe-imports.ts`**：扫描
   `deno compile`
   产物对应的源码根（`noj-core/src`、`noj-core/scripts`、`noj-cli/src`），任何
   `import(<非字面量>)` 直接失败；确需保留的必须登记进 `ALLOWED_NON_LITERAL`
   并写明理由。
   门禁自带正/反例控制断言（字面量放行、变量说明符命中、`import.meta`
   与注释不误报）， 解析规则一旦失效即失败，避免重演"门禁恒真 /
   路径漂移后永久报绿"。已注册进 `scripts/gate-list.ts`（`check-all` 与
   `check-ci` 共用清单），并补 7 条自测。
3. **回归验证落在产物上**：本次修复的验收不是跑测试，而是把重建的镜像装到部署实例上，
   用管理后台 `POST /api/v1/admin/settings/email/test-send` 真实发出一封邮件——
   只有编译产物行为才算证据。

## Alternatives considered

- **改成顶层静态 `import`（四个 Provider 全部立即加载）**：最省事，但会把
  `@alicloud/dm20151123`、腾讯云 SDK 拉进每次启动的求值路径（`mock`/`disabled`
  部署也照付），且丢掉 `resetEmailProvider()` 的降级重载能力。惰性 +
  字面量同时满足， 故不采用。
- **保留变量说明符，改为把 Provider 源码以资源文件随镜像分发、运行时按路径
  import**： 需要给镜像加
  `--include`/资源拷贝与路径解析逻辑，等于把编译期能解决的问题推到运行期，
  还引入产物与 `deno.json` 导入映射一致性的新风险。
- **只写测试，不加门禁**：测试跑的是源码，天然无法覆盖该缺陷——本次故障正是
  "测试全绿 + 生产全挂"，因此必须有静态门禁。
- **门禁只盯 `email.ts` 一个文件**：无法防止同类写法在 storage / content-review
  / CLI 新装配点重现；改为按源码根全量扫描。

## Consequences

- 邮件 Provider 在编译产物中可用；生产发信（验证、找回密码、管理后台测试）恢复。
- 源码根内新增任何变量说明符动态导入都会在 CI
  被拦截；确需例外时须在门禁内登记理由， 使"为什么这个可以"留在代码里。
- 门禁无法证明字面量导入的模块**确实**被 `deno compile` 内联（例如经 `npm:`
  规范化的 可选依赖仍可能运行时解析），因此产物级 e2e
  验证仍是必要的最后一道：本次以真实发信 + GHCR 镜像冒烟为准。
