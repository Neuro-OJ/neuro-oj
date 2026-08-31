## 1. 发布供应链工作流

- [x] 1.1 重构 `.github/workflows/release.yml` 的镜像标签计算，校验 Release/tag ref，生成唯一候选标签，并验证六个镜像均使用同一 Release 版本策略；用 YAML/脚本检查确认生产标签不含 `latest` 或 `beta`
- [x] 1.2 为候选镜像启用 BuildKit provenance/SBOM attestations，并输出候选 digest、源码 commit 和版本到后续步骤；用 workflow 静态检查确认这些输出存在
- [x] 1.3 增加 Trivy 镜像扫描和版本化误配置入口，确保高危/严重未豁免漏洞返回非零并阻止正式标签创建；用故意失败的扫描配置验证门禁行为
- [x] 1.4 增加 Cosign keyless 签名、SBOM attestation 和 GitHub OIDC provenance，确保签名目标为候选 digest 而非可变 tag；用 workflow 静态检查确认 `id-token`、`attestations` 和 `packages` 权限最小化声明
- [x] 1.5 增加正式标签发布后的 digest、签名、来源证明和镜像拉取验证，确保正式标签只指向候选 digest；用独立验证 job 覆盖六个镜像
- [x] 1.6 为六个生产镜像增加最小 smoke test，验证镜像可拉取、运行用户/关键文件正确且服务入口可执行；在 GitHub Actions 中执行并记录失败镜像

## 2. 镜像与生产部署护栏

- [ ] 2.1 获取并审查生产 Dockerfile 及生产 Compose 基础镜像的 `linux/amd64` digest，更新引用并通过所有生产镜像构建验证
- [x] 2.2 修改 `docker-compose.prod.yml`，将 `NOJ_VERSION` 改为必填并移除 `latest` 默认值；用 Compose config 测试覆盖缺少版本和合法版本两种场景
- [x] 2.3 强化 `scripts/deploy/deploy.sh` 的版本校验、当前版本/digest 记录和升级前备份提示；运行现有 `test-deploy.sh` 并增加非法/可变版本用例
- [x] 2.4 更新生产发布与部署文档，说明签名/SBOM 验证、Release 版本选择、升级前备份、应用回滚和数据库迁移兼容性；通过文档链接和命令审查验证步骤可执行

## 3. 自动化验证与验收

- [x] 3.1 新增仓库级供应链配置检查，覆盖生产 `latest`、未固定基础 digest、Release workflow 关键权限和缺少安全门禁；运行脚本验证通过与故意违规失败两种结果
- [ ] 3.2 运行 `openspec validate --change immutable-image-release --strict`、YAML 解析、Compose config、部署脚本测试和相关 Dockerfile 构建检查，修复所有可归因于本变更的失败
- [ ] 3.3 在 GitHub Actions 测试 Release 上完成六镜像发布、签名验证、SBOM/provenance 验证及候选→正式 tag 一致性检查，并保留 digest 清单作为验收记录
- [ ] 3.4 在 staging 使用已验证 Release tag 执行一次升级和一次回滚演练，记录健康检查、数据卷保持和数据库迁移兼容性结果

> 2.1 与 3.2 的 Dockerfile 构建检查已发起，但本地 Docker Hub 镜像元数据请求因网络 EOF/SSL 错误中断，需由 CI 完成验证；3.3 和 3.4 需要真实 GHCR/Sigstore 发布权限及 staging 环境。
