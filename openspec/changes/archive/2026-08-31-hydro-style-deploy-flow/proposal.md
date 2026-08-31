## Why

当前 NOJ 虽然支持下载部署脚本，但用户仍需要记住脚本路径、版本参数和安装目录，和
HydroOJ 的“一条命令开始安装”体验有差距。借鉴 HydroOJ
的入口设计可以降低首次部署门槛，同时保留 NOJ 对 Release、镜像签名和 Judge
隔离的安全要求。

## What Changes

- 新增面向用户的 `setup.sh` 远程入口，支持直接粘贴一条命令启动安装。
- 入口默认获取最新可用 Release，用户仍可通过 `--ref`
  固定版本以便复现、升级和回滚。
- 保留环境检测、交互式配置、Docker Compose
  初始化、健康检查和首个用户管理员引导。
- 简化部署文档和脚本帮助中的首选命令，补充 Hydro 风格的安装后操作说明。
- 保留 `check`、`install-env`、`--download-only`、`--dry-run` 和
  `--non-interactive` 等高级能力。

## Capabilities

### New Capabilities

- `one-command-deployment`: 通过远程入口脚本自动选择 Release 并启动 NOJ
  安装流程。

### Modified Capabilities

- `production-deployment`: 首次生产部署支持短命令入口和默认最新
  Release，同时继续允许显式固定版本。

## Impact

- 修改 `scripts/deploy/install.sh` 的默认版本解析和帮助信息。
- 新增仓库根目录远程入口 `setup.sh`。
- 更新生产部署文档、脚本索引和安装回归测试。
- 不新增运行时依赖；最新 Release 查询失败时明确报错，避免误部署未知版本。
