## Context

NOJ 的 Release workflow 已使用 Cosign 为镜像签名，但生产服务器上的部署脚本将 Cosign 作为默认前置条件。对于个人服务器或内网测试环境，额外安装 Cosign 会阻断一键安装，而镜像仍然可以通过固定 Release 版本拉取。

## Goals / Non-Goals

**Goals:**

- 默认安装不因缺少 Cosign 失败。
- 保留严格签名校验的 opt-in 路径。
- 让模板、提示、文档和测试反映真实默认行为。

**Non-Goals:**

- 不删除 Release workflow 的 Cosign 签名和验证门禁。
- 不自动下载未经用户确认的 Cosign 可执行文件。
- 不把镜像 tag 校验误认为镜像来源认证；严格模式仍使用现有证书身份规则。

## Decisions

- 将 `.env.prod.example` 的 `NOJ_ENFORCE_IMAGE_SIGNATURES` 默认值改为 `false`。
- 部署脚本继续以 `false` 作为关闭值；空值和其他值不作为关闭值，以避免旧配置意外降低安全级别。
- 文档将 Cosign 从必需前置条件改为可选的严格模式工具，并保留启用示例。
- 测试覆盖默认关闭时不检查 Cosign，以及显式开启时仍要求 Cosign 并验证镜像。

## Risks / Trade-offs

- [默认关闭后无法验证镜像来源] → 在模板和文档中明确风险，并保留 `true` 严格模式。
- [用户误以为 digest 等同签名] → 文档区分版本固定和来源验证。
- [旧配置行为变化] → 只有新模板默认关闭；已有配置中的显式 `true` 继续生效。

## Migration Plan

1. 新安装从模板获得 `NOJ_ENFORCE_IMAGE_SIGNATURES=false`。
2. 已有 `.env.prod` 保留原值，不自动覆盖；原来为 `true` 的部署仍继续校验。
3. 需要严格校验时安装 Cosign，并将配置改为 `true` 后执行 `start` 或 `verify`。
