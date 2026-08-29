## Context

HydroOJ 使用远程 setup
脚本作为唯一入口，用户可以复制一条命令开始安装，脚本默认使用当前发布版本，并通过可选参数处理独立
Judge 等特殊场景。NOJ 当前的 bootstrap
已经具备环境检查、源码下载、配置向导和生产生命周期管理，但默认命令仍要求用户理解
`--ref` 和 `--dir`。

## Decisions

- 在仓库根目录提供 `setup.sh`，它只负责从固定仓库的 `main` 分支获取 bootstrap
  并转交参数；实际业务逻辑仍在
  `scripts/deploy/install.sh`，避免维护两份安装逻辑。
- `install.sh` 的默认 ref 使用 GitHub Releases API 的最新非草稿 Release
  tag；`--ref` 和 `NOJ_BOOTSTRAP_REF`
  优先级高于自动解析。解析失败直接退出并给出固定版本示例，不回退到可能过期或不存在的硬编码版本。
- 远程入口支持通过参数继续使用现有的
  `check`、`install-env`、`--download-only`、`--dry-run`、`--non-interactive` 和
  `--ref` 能力；默认无参数等价于 `install`。
- 默认安装目录继续使用
  `/opt/neuro-oj`，因为生产部署需要保护配置和数据路径；无权限时给出明确的权限提示。用户可用
  `--dir` 改为其他路径。
- 安装完成提示直接引导用户访问网站并注册首个真实用户。NOJ
  已在注册事务中自动授予其管理员权限，因此不增加 Hydro 风格的额外 CLI 操作。
- 最新 Release API 只用于选择源码和镜像版本，生产部署仍由现有配置校验、镜像
  digest 和 Cosign 签名校验决定是否继续。

## Risks / Trade-offs

- [依赖 GitHub API] → 目标服务器需能访问 GitHub API；网络受限时用户可以显式传入
  `--ref`，但源码归档和镜像仍需可访问。
- [默认版本随时间变化] → 输出解析出的 tag，并在 `.env.prod`
  中写入该版本；升级和回滚仍使用明确版本。
- [直接执行远程入口] →
  文档同时提供先下载后检查的方式，且入口只转交到固定仓库脚本，不隐藏参数。
- [首个用户自动管理员] →
  安装后应立即注册或先限制站点访问；已有站点不会因该流程自动提权。

## Compatibility

- 现有 `bash scripts/deploy/install.sh --ref ... --dir ...` 用法保持不变。
- `scripts/deploy/install.sh` 从仓库下载的源码版本仍由 `--ref` 决定，不允许把
  `main` 作为生产镜像版本写入 `.env.prod`。
