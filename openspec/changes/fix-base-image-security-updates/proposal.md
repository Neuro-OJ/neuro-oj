## Why

`0.8.0-rc.3` 的发布流水线已经能够正常执行 Trivy，但三个候选镜像因 OpenSSL 的高危漏洞 CVE-2026-14456 被门禁拦截，且扫描结果显示均已有修复版本。若直接跳过扫描，发布镜像会带着已知可修复漏洞进入用户部署环境。

## What Changes

- 在全部 Python 评测镜像（evaluator、solution、solution-ai）构建过程中安装基础 Debian 系统的最新安全更新。
- 在全部 Python 评测镜像中升级存在已知高危漏洞的 setuptools、wheel 和 jaraco.context。
- 在 LLM Gateway 镜像构建过程中安装基础 Alpine 系统的最新安全更新。
- 保持基础镜像 digest 固定、非 root 运行和现有镜像构建流程不变。
- 增加回归检查，确保受影响镜像包含基础系统安全更新步骤。

## Capabilities

### New Capabilities

- `base-image-security-updates`: 生产镜像构建必须应用基础系统的安全更新，以便通过高危漏洞发布门禁。

### Modified Capabilities

<!-- 不修改现有用户功能；这是镜像构建安全能力的新增约束。 -->

## Impact

- 修改 `noj-judge/docker/evaluator-python/Dockerfile`、`noj-judge/docker/solution-python/Dockerfile`、`noj-judge/docker/solution-ai/Dockerfile` 和 `noj-llm-gateway/Dockerfile`。
- 修改供应链检查脚本和测试。
- 构建时间会略有增加；不改变应用运行时 API、部署配置或 Redis/PostgreSQL 数据。
