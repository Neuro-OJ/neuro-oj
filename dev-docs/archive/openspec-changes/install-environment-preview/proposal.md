## Why

当前安装脚本会直接进入依赖检查、版本获取和源码下载，用户只有在检查失败后才能看到缺少的环境信息。安装前先展示最低要求与当前检测结果，可以让运维人员在执行下载和部署前确认主机是否适合运行 NOJ。

## What Changes

- 在生产 `install` 真正开始前展示最低运行要求。
- 展示当前主机已检测到的 Linux/架构、CPU、内存、Swap、磁盘、Docker、Compose、基础工具和端口状态。
- 保持 `check` 使用同一套输出和检测逻辑，避免安装与独立检查结果不一致。
- 在获取 Release、下载源码或写入目标目录前完成环境预览和阻断性检查。
- 更新安装测试与生产部署文档，说明安装前预览内容。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `openspec/specs/production-deployment/spec.md`: 生产安装必须在副作用操作前展示要求与当前环境并完成宿主机检查。

## Impact

- 修改 `scripts/deploy/install.sh` 的安装前置流程和资源摘要。
- 修改 bootstrap 测试与生产部署文档。
- 不新增依赖，不修改生产 Compose、数据卷或配置格式。
