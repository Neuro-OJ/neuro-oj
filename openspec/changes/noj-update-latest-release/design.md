## Context

当前根目录 `noj` CLI 已能按 `.env.prod` 中的固定 `NOJ_VERSION` 同步部署文件并执行升级；首次安装的 bootstrap 已能从 GitHub Releases API 选择 Release。生产镜像和配置依赖不可变版本标签，因此自动升级必须是显式操作，并且不能把预发布版本误选为生产版本。

## Goals / Non-Goals

**Goals:**

- 为 `noj update` 增加 `--latest`，选择最新的非草稿、非预发布 Release。
- 在任何配置写入前完成网络响应解析、版本比较和现有升级前置检查。
- 复用现有 `update` 的部署文件同步、备份、镜像签名校验、Compose 升级和健康检查。
- 在失败时恢复或保持原始 `NOJ_VERSION`，并让固定版本升级和回滚行为不变。

**Non-Goals:**

- 不增加后台定时自动升级、systemd timer 或无人确认的服务替换。
- 不允许 `latest`、`beta` 等可变标签替代不可变 Release 标签。
- 不改变 Release 镜像构建、签名或数据库迁移策略。

## Decisions

### 使用 GitHub Releases API 查询稳定版本

调用 GitHub 的 latest Release API，该端点返回最新的非草稿、非预发布 Release tag。除校验 API 元数据外，目标 tag 还必须是纯数字稳定版本（如 `0.8.1` 或 `v0.8.1`），拒绝带 `-rc`、`-beta` 等后缀的历史误标标签。查询通过 HTTPS、超时和重试策略完成；若目标 tag 等于当前版本则执行成功的无操作返回。

选择 API 而非直接读取 `latest` 镜像标签，是因为 `latest` 是可变标签且不能表达签名、源码和部署文件的同一版本关系。保留固定标签也便于回滚。

### 仅在升级流程成功后持久化目标版本

先把目标版本写入临时配置文件，调用既有升级流程；只有升级成功后才提交配置文件。升级失败时删除临时文件并保持原 `.env.prod` 不变。这样可以避免服务升级失败后配置指向未运行版本。

### 复用现有 update/upgrade 入口

`--latest` 只负责解析目标版本和配置暂存，实际同步部署文件、创建备份、校验镜像、拉取镜像、执行迁移、启动服务和健康检查仍由已有逻辑负责，避免产生两套升级安全边界。

### 用环境变量覆盖配置文件路径和仓库

最新版本查询使用 `NOJ_UPDATE_REPOSITORY`（默认 `https://github.com/Neuro-OJ/neuro-oj`）和可选的 `NOJ_UPDATE_API_URL`，便于无 Docker 测试和私有镜像部署验证；生产默认值保持指向官方仓库。不会从 `.env.prod` 读取或输出敏感字段。

## Risks / Trade-offs

- [GitHub API 不可用] → 在修改配置前完成查询并返回明确错误；保留手动固定版本升级路径。
- [最新稳定 Release 尚未完成镜像发布] → 继续由现有镜像 digest/Cosign/健康检查门禁拦截，不宣称升级成功。
- [Release API 返回异常 JSON 或恶意 tag] → 严格校验响应中的 tag，拒绝空值、路径穿越、空格和可变标签。
- [升级中途服务失败] → 复用现有完整备份和诊断流程；暂存配置失败时自动清理，回滚仍通过旧固定 tag 执行。
- [网络查询增加升级耗时] → 使用 HTTPS、有限重试和连接超时，不影响不带 `--latest` 的固定版本升级。

## Migration Plan

1. 部署包含该功能的 `noj` 命令文件；现有 `.env.prod` 和数据卷无需迁移。
2. 在预发布环境执行 `noj update --latest`，确认只选择稳定 Release，并验证失败时配置不变。
3. 生产环境先执行 `noj backup` 或直接使用标准升级流程自动备份，再执行 `noj update --latest`。
4. 若升级后需要回滚，将 `.env.prod` 改回上一固定 Release tag，执行 `noj verify` 后按现有回滚流程启动；数据库迁移仍不自动回滚。
