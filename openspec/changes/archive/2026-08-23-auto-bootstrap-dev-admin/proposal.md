## Why

`devtool.sh start` 只启动服务，不会执行管理员引导。当开发数据库由性能测试或其他工具创建且没有管理员时，服务虽可用却无法登录管理后台，增加了本地开发的额外操作。

## What Changes

- 在 `devtool.sh start core` 和完整 `devtool.sh start` 中，在启动后端前执行幂等的管理员引导。
- 复用既有 `ADMIN_EMAIL` / `ADMIN_PASS` 配置与 RBAC 管理员判定，不覆盖已有账号密码。
- 将引导失败视为后端启动失败，避免提供一个无法管理的开发环境。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `admin-authorization`: 开发编排工具启动后端时自动确保存在可登录管理员。

## Impact

- `scripts/dev/devtool.sh` 的 `start core` 路径。
- 开发环境启动输出与相应 Shell 回归测试。
