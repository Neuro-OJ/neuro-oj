## Context

现有生产部署能力位于仓库内的 `scripts/deploy/deploy.sh`，生产主机仍需先获取完整仓库才能使用。新入口需要在没有本地源码的 Linux 环境中独立运行，并且不能复制 Compose 编排逻辑。

## Goals / Non-Goals

**Goals:**

- 提供可通过 `curl ... | bash` 或下载后执行的单文件入口。
- 从 HTTPS 仓库归档获取可复现的固定 ref，并支持自定义仓库、ref 和目标目录。
- 使用临时目录、安全校验和非覆盖策略保护主机已有部署。
- 下载完成后复用现有 `scripts/deploy/deploy.sh install`，保持生产流程单一来源。

**Non-Goals:**

- 不在 bootstrap 中实现 Docker Compose、数据库迁移、密钥生成或服务健康检查。
- 不自动更新已有安装，不删除数据卷、环境文件或备份。
- 不实现 GitHub API 认证、私有仓库凭据管理或 Kubernetes 部署。

## Decisions

### 1. 使用源码归档而不是要求 Git

脚本优先使用 `curl`，没有 curl 时回退到 `wget`，再用系统 `tar` 解压；这样生产主机只需常见 Linux 工具，不必安装 Git。仓库 URL 和 ref 通过参数传入，下载地址使用 HTTPS。

### 2. 默认使用固定 Release ref

默认 ref 使用当前稳定 Release `v0.1.0`，用户可以通过 `--ref` 选择其他已发布版本。生产部署文档明确建议使用不可变 Release tag，并使仓库 ref 与 `.env.prod` 中的 `NOJ_VERSION` 保持一致。

### 3. 临时目录和安全归档校验

下载文件写入 `mktemp` 创建的临时目录，解压前检查归档条目不得以 `/` 开头或包含 `..` 路径段，并要求归档只有一个顶层项目目录。目标目录不存在或为空时才安装；非空目标一律失败，避免覆盖 `.env.prod` 和部署数据。

### 4. 参数边界

Bootstrap 自己解析仓库、ref、目录、dry-run 和 download-only 参数；`--` 后的参数原样组成数组传给 `deploy.sh install`。脚本不 source 环境文件、不使用 `eval`，也不把 secret 写入输出。

### 5. 测试策略

新增 shell smoke test，使用假的下载器和本地测试归档验证帮助、dry-run、参数传递、目标目录保护、危险归档拒绝、临时文件清理和失败状态传播；真实网络、Docker 和生产服务继续由现有部署测试覆盖。

### 6. 环境检测与安装边界

`check` 命令只读检测宿主机，不要求先下载仓库；它报告 Linux/架构、基础命令、Docker/Compose、内存、磁盘和默认端口。`install-env` 只安装 `ca-certificates`、`curl`、`wget`、`tar` 和 `openssl` 等基础工具，并按 `apt-get`、`dnf`、`yum`、`apk` 或 `pacman` 选择包管理器。Docker Engine、Compose 插件和 Judge rootless daemon 不由脚本自动安装，缺失时输出官方文档地址和可执行的下一步，避免不透明的高权限系统修改。

### 7. 首次生产配置引导

首次创建 `.env.prod` 后，生产部署入口在具备 TTY 且未指定 `--non-interactive` 时进入交互引导。引导复用现有安全写入函数逐项更新配置：版本、域名和应用地址、管理员账号、邮件 Provider 与凭据、Judge 隔离 Docker socket 及其 GID；`CORS_ALLOWED_ORIGINS` 根据 `APP_URL` 自动设置。管理员密码使用隐藏输入、二次确认并要求至少 12 位，Provider 密钥也使用隐藏输入。没有 TTY 的脚本调用保持可自动化：只生成 600 权限的模板并返回明确的手工编辑提示，不尝试从标准输入猜测配置。

### 8. 当前架构兼容性提示

发布流水线当前只生成 `linux/amd64` 镜像，因此 bootstrap 在 `check` 和 `install` 入口均提前阻断 `aarch64`/`arm64` 主机，并提示使用 x86_64。待未来发布多架构 manifest 后，再将架构检查改为镜像 manifest 预检，而不是继续维护固定架构白名单。

## Risks / Trade-offs

- [HTTPS 归档仍依赖远程仓库可用性] → 提供 `--repo`、`--ref` 和下载失败诊断；生产使用固定 Release tag。
- [源码归档未提供额外签名校验] → 仅允许 HTTPS，并拒绝隐式更新；后续可增加发布签名或 SHA-256 参数，不在本变更中引入密钥分发体系。
- [非空目录拒绝会使升级需要额外命令] → 明确提示进入现有目录执行 `deploy.sh upgrade`，避免 bootstrap 意外覆盖配置。
- [归档格式依赖 GitHub 目录结构] → 校验单一顶层目录并在归档结构变化时快速失败，不静默复制不完整项目。
- [交互引导不适合无人值守部署] → 提供 `--non-interactive` 和无 TTY 自动降级提示，保留手工配置与 CI 失败边界。

## Migration Plan

1. 用户只下载 `scripts/deploy/install.sh`，使用 `--ref` 指定与生产镜像一致的 Release tag。
2. 首次运行将源码放入空目标目录并调用现有 `deploy.sh install`；配置仍写入目标目录的 `.env.prod`。
3. 后续升级继续在目标目录执行现有 `deploy.sh upgrade`，bootstrap 不覆盖已有目录。
4. 若 bootstrap 下载或解压失败，清理临时目录后重新执行即可；不会影响已有安装和数据卷。
