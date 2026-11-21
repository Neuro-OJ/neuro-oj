# 生产更新流程可靠性修复

## Why

在 `sng` 的真实升级中发现，生产更新流程存在多个会阻断或误报的问题：已有安装同步部署文件时会把自身监听端口误判为冲突；备份脚本无法校验 PostgreSQL dump；一键安装不会准备后续升级所需的 GPG 口令；升级重建应用容器后 Nginx 可能继续使用旧容器地址；更新过程中替换正在执行的 bootstrap 文件还可能造成命令收尾异常。

这些问题会让安全门禁无法区分真实风险与已有部署状态，也会让已经完成的升级返回失败，增加生产排障和重复操作风险。

## What Changes

- 让已有安装的部署文件同步跳过仅针对首次启动的宿主机端口占用检查，并保留首次安装的端口门禁。
- 修正 PostgreSQL 备份结构校验，使 `pg_restore` 从标准输入读取 dump，并补充回归测试。
- 首次安装时在受限的仓库外路径自动创建随机 GPG 备份口令文件，并将非敏感路径写入生产配置；已有口令文件和用户显式配置必须保留。
- 更新完成后刷新 Nginx 反向代理容器，避免上游应用容器重建后出现旧 IP 导致的 502。
- 让 bootstrap 文件同步不执行被同步版本的安装流程，并确保同步脚本收尾返回真实状态。
- 对固定版本标签给出明确的 Release tag 提示，保留 `v0.8.1` 等不可变标签行为。

## Capabilities

### Modified Capabilities

- `openspec/specs/production-deployment/spec.md`：生产安装、升级和备份流程增加上述可靠性与可恢复性要求。

## Impact

- 修改根目录 `noj`、`scripts/deploy/install.sh`、`scripts/deploy/deploy.sh`、`scripts/deploy/backup.sh` 及部署测试。
- 生产配置新增非敏感的备份口令文件路径；口令明文只保存于权限受限的仓库外文件。
- 不修改数据库 schema、数据卷或业务 API。
