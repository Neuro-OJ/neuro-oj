## Context

`0.8.0-rc.3` 使用的 Trivy v0.70.0 已正常解析并扫描镜像。失败结果显示 Python 镜像中的 Debian OpenSSL 为 `3.5.6-1~deb13u2`，修复版本为 `3.5.7-1~deb13u2`；LLM Gateway 中 Alpine OpenSSL 为 `3.5.7-r0`，修复版本为 `3.5.8-r0`。基础镜像本身仍需通过 digest 固定以保持供应链可追溯。

## Goals / Non-Goals

**Goals:**

- 在构建时更新受影响基础系统包，使已知 OpenSSL 修复进入生产镜像。
- 让静态供应链检查能阻止安全更新步骤被删除。
- 保持现有容器用户、启动命令和基础镜像 digest 约束。

**Non-Goals:**

- 不降低 Trivy 的 HIGH/CRITICAL 失败门禁。
- 不通过忽略 CVE、修改严重性或允许扫描失败来解决问题。
- 不升级应用依赖、语言运行时或 Docker Compose 基础设施镜像；若这些组件有独立漏洞，应单独处理。

## Decisions

- Python Dockerfile 在切换到非 root 用户前执行 `apt-get update`、`apt-get upgrade` 和清理 apt 列表。这样可在保留固定 Python 基础镜像 digest 的同时获取 Debian 安全仓库中的修复包。
- Alpine Dockerfile 执行 `apk upgrade --no-cache`。该方式直接使用基础镜像声明的 Alpine 仓库更新系统包，并不改变 Deno 版本或基础镜像 digest。
- 在现有 `scripts/release/check-supply-chain.sh` 中增加针对三份 Dockerfile 的文本检查，并在 `scripts/release/test-supply-chain.sh` 中模拟删除步骤的负向测试。相比构建完整镜像，静态检查更快，适合作为 PR 早期门禁；实际 CVE 是否清除仍由 Release Trivy 扫描确认。
- 不把安全更新改成动态基础镜像 tag。动态 tag 会削弱现有 digest 可复现性，而构建阶段的包更新已能覆盖当前已确认的安全修复。

## Risks / Trade-offs

- [安全仓库内容会随时间变化，构建结果不完全字节可复现] → 继续固定基础镜像 digest，并让 Release workflow 生成 SBOM；后续可在单独变更中引入快照仓库。
- [构建需要访问 Debian/Alpine 包仓库] → 构建失败时让发布门禁直接失败，不发布未更新镜像。
- [未来基础镜像可能已包含更新，额外升级仍增加构建时间] → 保留安全更新步骤，确保基础镜像重建和新漏洞出现时都能获得补丁。

## Migration Plan

1. 修改三份受影响 Dockerfile 和供应链检查。
2. 在本地运行 Shell、供应链、Dockerfile digest 和 OpenSpec 校验；条件允许时构建受影响镜像并运行 Trivy。
3. 通过 PR 合并后重新创建下一个 RC，确认所有镜像完成漏洞扫描、SBOM、签名和发布验证。
4. 如果更新步骤造成兼容性问题，回滚该 PR；回滚会重新暴露当前已知漏洞，因此不能作为最终发布方案。
