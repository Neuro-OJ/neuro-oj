## Context

当前 `.github/workflows/release.yml` 在六个镜像上直接同时推送版本标签和 `latest`，生产 Compose 又把 `latest` 作为默认值。仓库已经有生产 Dockerfile、生产 Compose、部署脚本和备份恢复脚本，但缺少“候选构建 → 安全门禁 → 正式标签 → 发布验证”的闭环。相关既有要求见 `openspec/specs/production-release-pipeline/spec.md`，本变更对其中的可变标签行为进行修改。

## Goals / Non-Goals

**Goals:**

- 让正式 Release 标签只指向已扫描、已生成 SBOM、已签名并已验证的镜像 digest。
- 固定生产构建和基础设施镜像的内容摘要，阻止无意的上游 tag 漂移。
- 让部署脚本拒绝缺少版本、使用 `latest` 或格式明显非法的生产版本。
- 在 GitHub Actions 中自动验证六个正式镜像的 digest、签名、来源证明和最小运行能力。
- 保留现有升级前备份和数据卷策略，并把回滚动作写成可执行文档。

**Non-Goals:**

- 不实现 Kubernetes、蓝绿发布、自动扩缩容或云厂商专用发布平台。
- 不自动执行生产环境数据库降级迁移；数据库迁移必须保持向前兼容或由运维人工恢复备份。
- 不把开发/E2E 镜像改造成生产发布物；只覆盖生产 Release 工作流和生产 Compose 使用的镜像。
- 不承诺在没有真实生产主机的本地环境完成一次生产回滚演练；CI 只验证回滚输入和脚本护栏。

## Decisions

### 1. 使用候选标签隔离安全门禁与正式发布

每个矩阵任务先构建并推送唯一候选标签，例如 `0.1.2-build.<run_id>-<attempt>`。候选构建启用 BuildKit 的 provenance/SBOM attestations；随后使用 Trivy 扫描，并用 Cosign keyless 签名候选 digest、附加可验证的 SBOM attestation。全部矩阵任务成功后，再由验证任务把同一 digest 创建为正式 Release tag。

选择候选标签而非先推正式标签再扫描，是为了避免扫描失败后留下看似可部署的正式镜像。正式标签只作为 digest 的可读别名，不能重新构建或重新打包。

### 2. 使用 GitHub OIDC 的 keyless 签名与 provenance

Release workflow 请求 `id-token: write`，通过 Cosign Fulcio/Rekor 完成 keyless 签名，并使用 GitHub Actions provenance attestation 绑定仓库、工作流和 commit。部署侧和发布验证侧按仓库及 Release workflow 身份验证证书身份，避免把私钥写入仓库或长期保存到生产主机。

替代方案是维护 Cosign 私钥并通过 GitHub Secret 注入；该方案需要密钥轮换和泄露响应，且长期密钥本身成为新的高价值秘密，因此不采用。

### 3. 以不可变 Release tag 作为生产 Compose 输入

`NOJ_VERSION` 改为必填，并拒绝 `latest`/`beta`/空值。当前仓库的生产部署以 Release tag 作为人类可操作的版本标识；发布工作流记录并验证该 tag 对应 digest，部署文档要求先完成签名验证。后续若需要严格 digest 锁定，可在不改变服务拓扑的情况下将 Compose 输入扩展为每个服务的 digest 引用。

不把 Compose 改成单一全局 digest 变量，因为六个服务的 digest 不同，且会显著降低人工回滚时的可读性；版本 tag + 发布清单已经满足本变更的不可变 Release tag 要求。

### 4. 固定生产基础镜像 digest

生产 Dockerfile 的 builder/runtime 基础镜像以及生产 Compose 的 Nginx、PostgreSQL、Redis、MinIO 和 `mc` 镜像均使用平台支持 `linux/amd64` 的 digest。digest 更新作为显式依赖升级，必须通过构建和安全扫描后再合入。

### 5. 把配置检查和发布验证做成独立脚本

新增无外部服务依赖的 shell 检查，扫描生产 Dockerfile、Compose 和 release workflow 的关键约束（无生产 `latest` 回退、基础镜像 digest、必填版本）。发布验证脚本负责从 GHCR 拉取实际版本 tag，检查 digest、Cosign 签名和基础容器命令；复杂的依赖服务健康检查仍由现有 staging acceptance 负责。

## Risks / Trade-offs

- [GHCR 或 Sigstore 暂时不可用] → 正式 Release 会失败；候选镜像可保留用于重试，不创建正式部署标签。
- [Trivy 将未修复高危漏洞作为门禁] → 上游基础镜像更新可能阻塞发布；允许通过版本化、可审计的 ignore 配置处理明确误报，不允许全局关闭门禁。
- [Release tag 仍可能被仓库管理员手工移动] → GitHub 分支/标签保护与发布流程必须限制重写；部署前验证签名身份和发布清单，发现 digest 不匹配即拒绝。
- [基础镜像 digest 更新成本增加] → 通过定期依赖更新任务和单独的镜像升级 PR 管理，避免隐式漂移。
- [数据库迁移无法自动回滚] → 升级前强制备份，文档要求向前兼容迁移；失败回滚只切换应用镜像，数据恢复由人工按备份流程执行。
- [本地 Docker 环境无法访问真实 GHCR/Sigstore] → 本地验证覆盖 Compose 配置、版本护栏和脚本逻辑；真实镜像签名/发布验证由 GitHub Actions 执行。

## Migration Plan

1. 合入工作流、基础镜像 digest、Compose 版本护栏和部署脚本测试。
2. 创建一个测试 Release，确认六个候选镜像均完成扫描、SBOM、签名和 provenance，再生成正式版本标签。
3. 在 staging 使用该版本的签名验证结果启动 Compose，执行健康检查和基础 smoke test。
4. 记录当前生产版本和镜像 digest；升级前执行现有备份脚本。
5. 若升级失败，将 `NOJ_VERSION` 切换为上一版本，重新执行部署并按数据库兼容性说明决定是否恢复数据。

## Open Questions

- Sigstore 的证书身份过滤条件需要在仓库实际组织/工作流名称确定后，在部署平台的验证命令中固定；这不改变仓库内的发布流程和验收标准。
