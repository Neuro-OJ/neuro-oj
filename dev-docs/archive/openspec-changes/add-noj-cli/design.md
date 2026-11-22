## Context

当前生产运维逻辑集中在 `scripts/deploy/deploy.sh`，已经包含配置校验、安装、启动、升级、停止、状态、日志、备份和镜像验证。`setup.sh` 负责远程获取安装脚本，生产安装目录本身还没有统一的短命令入口。详见 proposal.md - Why。

## Goals / Non-Goals

**Goals:**

- 在生产安装目录提供可执行的根目录 `noj` 命令。
- 让 `noj start`、`noj stop`、`noj update` 和管理命令复用现有生产脚本的安全逻辑。
- 提供 `restart` 和 `config check` 两个便捷操作，并正确传播失败退出码。
- 更新已有安装时同步安装入口脚本，但保留 `.env.prod`、备份目录和 Docker 数据卷。
- 安装完成后可直接执行 `noj`，优先使用 `/usr/local/bin/noj`，权限不足时回退到用户级 `~/.local/bin/noj` 并更新登录 PATH。
- `setup.sh` 作为唯一推荐的首次安装入口，内部 bootstrap 完成源码获取后调用目标目录的 `noj install`；`noj update` 先刷新部署文件，再调用 `deploy.sh upgrade`。
- 通过帮助信息和文档明确命令、参数和数据安全边界。

**Non-Goals:**

- 不重写现有 Compose 编排、备份实现、镜像签名验证或配置解析逻辑。
- 不自动修改 `NOJ_VERSION` 以追踪最新版本；`noj update` 使用 `.env.prod` 中已经配置的目标版本。
- 不让 `noj update` 自动选择最新版本；它使用 `.env.prod` 中的 `NOJ_VERSION` 下载同版本部署文件，随后执行升级。
- 不提供全局系统包安装；仅创建指向当前生产安装目录的 `noj` 软链接，不覆盖已有同名命令。
- 不把本地开发编排 `scripts/dev/devtool.sh` 与生产 `noj` 命令混为一体。

## Decisions

### 1. 使用根目录 Shell 入口并委托生产脚本

新增根目录可执行文件 `noj`。它根据自身路径计算安装目录，校验 `scripts/deploy/deploy.sh` 存在后再以 `bash` 调用底层脚本。这样从任意当前目录执行绝对路径都能定位正确配置，同时不会复制生产安全逻辑。

命令映射如下：

| `noj` 命令 | 底层行为 |
| --- | --- |
| `install` | `deploy.sh install` |
| `start` | `deploy.sh start` |
| `stop` | `deploy.sh stop` |
| `restart` | 先执行 `deploy.sh stop`，成功后执行 `deploy.sh start` |
| `update` | `deploy.sh upgrade` |
| `status` | `deploy.sh status` |
| `logs [service] [--follow]` | `deploy.sh logs ...` |
| `backup` | `deploy.sh backup` |
| `verify` | `deploy.sh verify` |
| `config check` | `deploy.sh verify`，执行无服务变更的配置与镜像检查 |

`upgrade` 保留为底层兼容命令；`update` 只提供更易理解的用户入口，并在调用兼容升级流程前刷新部署文件。

### 2. 只允许已定义的子命令

入口脚本使用显式命令白名单。未知命令、缺失 `config` 子命令或底层脚本缺失时返回非零退出码并显示帮助，避免把任意参数误传给错误的生产操作。已定义命令之后的参数按原样传给底层脚本，以保留 `--env-file`、`--backup-dir`、`--follow` 等现有能力。

### 3. 更新安装目录时同步入口文件

`scripts/deploy/install.sh` 已支持识别已有安装并更新部署文件。扩展该分支，使其同时复制仓库根目录的 `noj` 并恢复可执行权限；`.env.prod`、备份目录和数据卷继续按现有逻辑保留。新安装则随源码归档自然包含该文件。

### 4. 注册标准 PATH 命令

安装流程成功后调用生产安装目录中的 `noj` 自注册入口。默认尝试创建
`/usr/local/bin/noj -> <安装目录>/noj`；如果当前用户没有写权限，则回退到
`~/.local/bin/noj`，并在 `~/.profile` 中补充该目录。已有非本项目同名文件或软链接时
不覆盖，只给出人工处理提示。根目录 `noj` 解析自身软链接后再定位安装目录，确保通过
`/usr/local/bin/noj` 调用时仍使用正确的生产配置。

### 5. 测试采用无 Docker 的命令路由测试

新增脚本测试使用临时伪造的底层部署脚本，验证路径解析、命令映射、参数透传、`restart` 顺序、`update` 别名、帮助和错误退出码。现有生产部署测试继续覆盖真实配置校验、备份、Compose 和 Docker socket 安全边界；不因新增入口而重复启动生产服务。

## Risks / Trade-offs

- [风险] `noj update` 依赖用户先修改 `.env.prod` 中的 `NOJ_VERSION`，用户可能以为它会自动选择最新版本。→ [缓解] 帮助和 README 明确说明目标版本来源，并保留 `--dry-run` 等底层检查能力。
- [风险] `restart` 在停止成功、启动失败时会产生服务暂时不可用窗口。→ [缓解] 复用现有健康检查并传播启动失败；正式升级仍使用带备份的 `update`。
- [风险] 安装目录中的 `noj` 可能因手工复制丢失执行权限。→ [缓解] 安装/更新脚本显式执行 `chmod 755`，帮助文档同时提供 `bash ./noj` 备用调用方式。
- [风险] 底层脚本未来新增命令但入口白名单未同步。→ [缓解] 在路由测试中覆盖已支持命令，并在文档中把 `noj` 定义为稳定的常用入口，底层脚本仍可用于高级操作。
