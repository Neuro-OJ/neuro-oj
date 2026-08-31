## Why

Cosign 用于验证生产镜像来源，但不是 NOJ 运行所需的组件。当前生产模板默认强制开启签名校验，导致普通用户在没有安装 Cosign 时无法完成一键部署。将校验改为可选可以降低部署门槛，同时保留需要供应链校验的用户的启用能力。

## What Changes

- 生产配置模板默认关闭 Cosign 镜像签名校验。
- 安装和启动流程在校验关闭时不要求宿主机安装 Cosign，也不执行签名验证。
- 保留 `NOJ_ENFORCE_IMAGE_SIGNATURES=true` 作为显式严格校验开关。
- 更新错误提示、安装文档和测试，明确关闭校验的安全影响与开启方式。

## Capabilities

### New Capabilities

- `optional-image-signature-verification`: 镜像签名校验默认可选，严格模式由用户显式开启。

### Modified Capabilities

<!-- 无主规范需求需要修改；本变更新增可选校验能力。 -->

## Impact

- 修改 `.env.prod.example`、`scripts/deploy/deploy.sh`、生产部署文档和部署测试。
- 不改变镜像发布工作流的签名行为；Release 镜像仍可被签名，变化只影响部署端是否默认验证。
