## Purpose

为 Linux 用户提供一个可独立下载的生产部署入口，使用户无需预先获取完整仓库即可安全获取指定版本源码并启动 Neuro OJ 部署流程。

## ADDED Requirements

### Requirement: 独立下载与版本选择

Bootstrap 脚本 MUST 可脱离仓库目录运行，使用 HTTPS 从指定仓库下载源码归档，并支持通过参数选择仓库地址、固定 ref 和目标目录；默认 ref MUST 是可复现的固定版本或由脚本明确声明的稳定版本。

#### Scenario: 仅下载一个脚本后执行部署

- **WHEN** 用户在没有 Neuro OJ 本地源码的 Linux 主机上执行 bootstrap 脚本并提供完整部署配置
- **THEN** 脚本下载指定 ref 的源码、准备目标目录，并调用仓库内生产部署入口完成部署

#### Scenario: 自定义仓库版本和目录

- **WHEN** 用户传入自定义仓库、ref 或目标目录
- **THEN** 脚本使用这些值下载源码，不依赖当前工作目录或本地 Git 仓库

#### Scenario: 下载失败

- **WHEN** curl/wget 不可用、网络请求失败、归档无效或 ref 不存在
- **THEN** 脚本返回非零退出码，删除临时下载文件，并给出不包含敏感信息的修复提示

### Requirement: 安全解压与已有安装保护

Bootstrap MUST 在临时目录中解压归档，拒绝绝对路径或目录穿越条目；目标目录存在且非空时 MUST 拒绝覆盖，不得删除已有环境文件、备份或数据；下载完成后 MUST 清理临时文件。

#### Scenario: 目标目录为空

- **WHEN** 用户指定的目标目录不存在或为空目录
- **THEN** 脚本将下载的项目完整放入目标目录，并保留可执行部署脚本权限

#### Scenario: 目标目录已有部署

- **WHEN** 目标目录包含已有文件或 `.env.prod`
- **THEN** 脚本返回非零退出码并提示用户使用现有部署脚本升级，不覆盖目标目录内容

#### Scenario: 归档包含危险路径

- **WHEN** 下载归档包含绝对路径或 `..` 路径段
- **THEN** 脚本拒绝解压并删除临时目录

### Requirement: 参数传递与可诊断性

Bootstrap MUST 提供帮助信息、dry-run 和下载完成后的部署入口调用；部署入口失败时 MUST 原样返回非零状态，并清晰说明用户可继续执行的命令；脚本输出不得打印环境文件中的 secret。

#### Scenario: dry-run

- **WHEN** 用户使用 `--dry-run`
- **THEN** 脚本展示将使用的仓库、ref、目标目录和下载地址，但不得下载归档、创建部署目录或启动服务

#### Scenario: 下载后部署参数传递

- **WHEN** 用户向 bootstrap 传入生产部署参数
- **THEN** 脚本将参数传给目标目录内的生产部署入口，且不通过 `eval` 或 source 环境文件解析参数

#### Scenario: 部署失败

- **WHEN** 目标项目的生产部署入口失败
- **THEN** bootstrap 返回相同的失败结果，并提示用户进入目标目录查看 `status` 或 `logs`

### Requirement: Linux 环境检测与基础依赖安装

Bootstrap MUST 提供只读的 `check` 命令，检测 Linux 系统、支持的 CPU 架构、Bash、curl/wget、tar、openssl、Docker Engine、Docker Compose v2、可用内存、目标目录所在磁盘和默认 Web 端口，并以非零状态报告阻断性缺失项；Bootstrap MUST 提供 `install-env` 命令，使用当前系统可识别的包管理器安装缺失的基础工具，但 MUST NOT 未经单独确认修改 Docker 软件源、安装 Docker daemon、创建 rootless daemon 或改变宿主机权限。

#### Scenario: 环境检测通过

- **WHEN** 用户执行 `install.sh check` 且 Linux 主机具备所需基础工具、Docker daemon 和 Compose v2
- **THEN** 脚本输出系统与依赖版本、资源摘要和端口检查结果，并返回零状态

#### Scenario: 环境检测失败

- **WHEN** 用户执行 `install.sh check` 且系统不是 Linux、架构不受支持、基础工具缺失、Docker daemon 不可用或 Compose v2 缺失
- **THEN** 脚本返回非零状态，列出缺失检查项和修复建议，不下载源码、不创建安装目录、不启动服务

#### Scenario: 安装基础依赖

- **WHEN** 用户执行 `install.sh install-env` 且当前发行版提供受支持的包管理器
- **THEN** 脚本以 root 或明确的 sudo 权限安装基础工具，随后重新检测环境；Docker 缺失时只输出官方安装提示并保持非零状态

#### Scenario: 不支持的发行版

- **WHEN** 用户执行 `install.sh install-env` 且无法识别受支持的包管理器或当前系统不是 Linux
- **THEN** 脚本返回非零状态，输出手工安装基础工具和 Docker/Compose 的提示，不执行不确定的系统修改

### Requirement: 首次生产配置交互引导

生产部署入口 MUST 在首次创建 `.env.prod` 后、检测配置前提供交互式引导；引导 MUST 询问并写入
`NOJ_VERSION`、`DOMAIN`、`APP_URL`、管理员邮箱与密码、邮件 Provider 及其必要凭据、
`JUDGE_DOCKER_SOCKET` 和 `JUDGE_DOCKER_SOCKET_GID`，并可根据域名自动设置
`CORS_ALLOWED_ORIGINS`。密码和云厂商密钥 MUST 使用隐藏输入，不得回显或写入日志；管理员密码 MUST
要求至少 12 位并二次确认。已有 `.env.prod` MUST 保留，不得被引导覆盖；无 TTY 或显式
`--non-interactive` 时 MUST 给出编辑配置文件和重新执行命令，并以非零状态退出。

#### Scenario: 交互式首次配置

- **WHEN** 用户在终端首次执行生产安装且 `.env.prod` 不存在
- **THEN** 脚本逐项引导用户填写生产配置，隐藏敏感输入，完成后继续执行配置校验和服务部署

#### Scenario: 非交互式首次配置

- **WHEN** 用户在无 TTY 环境或使用 `--non-interactive` 首次执行生产安装
- **THEN** 脚本创建权限为 600 的配置模板，列出需要填写的配置项和后续命令，并返回非零状态

#### Scenario: 敏感输入保护

- **WHEN** 用户输入管理员密码或邮件 Provider 密钥
- **THEN** 终端不回显输入，脚本输出不包含输入值，配置文件权限保持为 600
