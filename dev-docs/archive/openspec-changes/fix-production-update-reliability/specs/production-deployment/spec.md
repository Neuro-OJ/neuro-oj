## ADDED Requirements

### Requirement: 生产更新必须区分同步检查与启动检查

已有安装执行部署文件同步时，系统 MUST 不因当前 NOJ 栈自身占用的端口而阻断同步；首次安装或真正启动服务时仍 MUST 检查宿主机端口冲突。

#### Scenario: 已有安装同步文件

- **WHEN** 用户执行固定版本 `noj update`，且配置的 Nginx 端口已由当前 NOJ Compose 栈监听
- **THEN** 系统同步部署文件并继续升级，不把当前 NOJ 自身监听报告为阻断错误

### Requirement: 生产备份必须可校验且默认可用于升级

首次安装或升级前，系统 MUST 确保存在权限为 `600` 或 `400` 的仓库外 GPG 口令文件；PostgreSQL 自定义格式 dump MUST 能通过 `pg_restore --list` 校验。

#### Scenario: 首次安装准备备份口令

- **WHEN** 用户完成首次生产配置并执行安装
- **THEN** 系统生成或复用受限的备份口令文件，记录非敏感路径，并提示用户保存该文件

#### Scenario: PostgreSQL 备份校验

- **WHEN** 系统创建完整生产快照
- **THEN** `pg_restore` 从标准输入读取宿主机生成的 dump，校验成功后才写入 `SUCCESS`

### Requirement: 升级后反向代理必须指向新容器

升级或启动重建应用容器后，系统 MUST 刷新 Nginx 反向代理，使入口不会继续使用已失效的旧容器地址。

#### Scenario: 应用容器重建

- **WHEN** Core 或 UI 容器因版本升级被重建
- **THEN** 系统在健康检查流程中重新创建 Nginx，并确认入口健康检查成功

### Requirement: 部署文件同步不得执行目标安装流程

`install.sh --files-only` MUST 只同步部署文件和命令，不启动服务、不执行目标版本的 install 流程，并 MUST 返回真实同步状态。

#### Scenario: 更新时同步 Release 文件

- **WHEN** `noj update` 调用 bootstrap 的 `--files-only` 模式
- **THEN** bootstrap 完成同步后退出，控制权返回当前更新流程，由当前部署脚本执行 upgrade
