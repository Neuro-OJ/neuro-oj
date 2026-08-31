## Why

当前发布工作流虽然可以构建并推送生产镜像，但仍允许 `latest` 作为部署回退标签，且没有把漏洞扫描、SBOM、签名证明和发布后验证组成强制门禁。这样会削弱镜像来源追溯、构建可复现性和故障回滚能力；随着生产部署脚本已经具备基础升级/备份能力，现在补齐发布供应链是合适的时机。

## What Changes

- 将生产镜像发布改为使用经过校验的不可变 Release tag，并禁止生产 Compose 默认使用 `latest`。
- 固定生产 Dockerfile 和生产 Compose 中仍然漂移的基础镜像 digest。
- 在 Release workflow 中生成并发布 SBOM，执行镜像漏洞扫描，并在扫描失败时阻断发布。
- 使用 Cosign keyless 签名和 GitHub OIDC provenance，使镜像可追溯到仓库、Release 和源码 commit。
- 对实际推送的镜像执行 manifest/digest 校验、拉取验证和最小容器健康检查。
- 为部署脚本增加版本格式校验、升级前后版本记录和可操作的回滚提示；明确数据库迁移不可自动回滚的兼容性边界。
- 更新生产部署文档与发布规范，记录镜像验证、升级和回滚流程。

## Capabilities

### New Capabilities

- `production-image-supply-chain`: 定义生产镜像的可追溯构建、SBOM、漏洞门禁、签名证明和发布后验证。

### Modified Capabilities

- `production-release-pipeline`: 将 Release 标签、生产 Compose 镜像引用、发布验证和升级/回滚要求从可变标签行为改为不可变发布行为。

## Impact

- 修改 `.github/workflows/release.yml`，新增镜像元数据、SBOM、Trivy 扫描、Cosign 签名/证明和发布后校验步骤。
- 修改 `docker-compose.prod.yml`、生产 Dockerfile 及必要的环境模板，移除生产镜像对 `latest` 的默认依赖并固定基础镜像 digest。
- 修改 `scripts/deploy/deploy.sh` 和生产部署文档，强化版本检查、升级记录及回滚操作说明。
- 新增仓库内发布链路测试，验证 workflow/Compose 配置不会重新引入可变生产标签。
- 不引入 Kubernetes、云厂商专用服务或自动化数据库降级迁移；真实生产升级/回滚演练仍需部署环境执行。
