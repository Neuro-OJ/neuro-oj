## Why

正式镜像验证已能完成来源证明校验，但 `noj-llm-gateway` 的 smoke test 发现容器仍以 root 用户运行。生产网关不需要 root 权限，继续使用 root 会违反发布链路的最小权限要求并阻止 RC 发布通过。

## What Changes

- 为 LLM Gateway 镜像创建专用的非 root 运行用户。
- 让网关进程默认使用该用户启动，并确保应用目录可读。
- 保留发布验证对非 root 运行的检查。

## Capabilities

### New Capabilities

- `gateway-container-hardening`: 规定 LLM Gateway 生产容器以非 root 用户运行。

### Modified Capabilities

## Impact

- 影响 `noj-llm-gateway/Dockerfile` 的运行时用户配置。
- 影响正式镜像 smoke test 的验证结果。
- 不改变网关端口、启动命令、API 或配置项。
