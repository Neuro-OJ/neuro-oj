# NOJ Capability Seam

可替换能力遵循“接口 / 实现 / 消费者”三段式：

- **Service Definition**：声明接口与共享类型（如 `StorageProvider`）。
- **Service Provider**：具体实现（如 `LocalStorageProvider`、`S3StorageProvider`）。
- **Consumer**：使用方（如支持包上传/下载服务）。

依赖方向必须为 `Consumer → 接口 ← Provider`，消费者不得 import 具体 Provider。

## 当前 Seam

| 能力 | 接口 | 实现 | 消费者 |
|---|---|---|---|
| 存储 | `src/lib/storage/types.ts` | `local.ts` / `s3.ts` | `factory.ts` 及使用 `StorageProvider` 的服务 |
| 邮件 | `src/lib/email.ts`（入口） | `email-providers/{mock,aliyun,tencent}.ts` | 密码重置等服务 |
| LLM Provider | `noj-llm-gateway` 的 provider 抽象 | 各 provider 实现 | 网关路由/审计 |
| 搜索 | `src/services/search.ts`（暂为单实现） | — | 搜索路由 |

## 校验

`scripts/verify-capability-seams.ts` 扫描 `noj-core/src`，禁止业务代码直接 import 具体 Provider 文件；只允许 factory/mod/index 等装配点引用。
