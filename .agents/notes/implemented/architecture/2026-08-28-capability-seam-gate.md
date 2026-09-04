# Agent Note: Capability Seam 文档与依赖方向校验

Status: implemented

## Problem

可替换能力（存储、邮件、LLM Provider）虽然已有接口/实现/消费者雏形，但没有文档说明依赖方向，也没有机器检查防止业务代码直接 import 具体 Provider。

## Decision

新增 `dev-docs/engineering/capability-seams.md` 说明三段式 seam 模式，并新增 `scripts/verify-capability-seams.ts`：

- 禁止 `noj-core/src` 业务代码直接 import `storage/local.ts`、`storage/s3.ts`、`email-providers/*` 等具体 Provider。
- 只允许 factory/mod/index/email.ts 等装配点引用。
- 将校验加入 `check-ci.ts` / `check-all.ts`。

## Alternatives considered

- 不写校验：依赖方向靠 code review，容易漏。
- 立即重构 LLM/Search 为完整 seam：改动面大，当前先固化已有约束。

## Consequences

- 新增 Provider 或消费者时，错误依赖方向会在 CI 失败。
- 为后续 Storage/LLM/Email/Search 的进一步 seam 化提供基础。
