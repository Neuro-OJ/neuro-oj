# Agent Note: noj-cli 脚本同步已知缺陷

Status: implemented

## Problem

noj-cli 在替代 `scripts/deploy/*.sh` 和 `scripts/deploy/restore-drill.sh` 的过程中，为控制迁移范围采用了简化实现。当前仍存在与原有 shell 脚本不完全对齐的已知缺陷，需要记录以便后续迭代时逐项补齐。

## Decision

将以下差距记录为已知缺陷，当前不再继续实现，后续按需补全：

1. **`install.sh` 文件同步 / `--files-only` 未实现。**
   `update` 目前直接执行 `docker compose pull && up -d`，没有先同步同版本部署文件和 noj-cli 二进制。

2. **首次交互安装向导未完整复刻 `deploy.sh` 边界。**
   已实现基础 PromptIO 引导（核心字段），但“复用旧配置”“面板模式”“配置暂存”等交互边界尚未对齐。

3. **`restore-drill` 的部分脚本能力未完全移植。**
   失败报告、Prometheus textfile 指标、失败时自动 `down -v --remove-orphans` 清理等细节仍缺失。

4. **生产 `verify` 不等价于原脚本的完整校验。**
   当前 `verify` 复用 `config check`（配置 + Compose config），未移植镜像 digest / Cosign 签名验证。

5. **`check` 改用 `doctor`。**
   环境检测已 Deno 化，但与 `install.sh check` 的完整输出/资源摘要细节不完全一致。

## Alternatives considered

- 继续在本次迭代中全部补完：工作量大，且当前 PR 已包含完整可用命令集，先交付并记录缺口更稳妥。
- 不记录：后续容易遗忘这些 shell parity 差距，导致用户误以为完全等价。

## Consequences

- noj-cli 当前可作为主要运维入口，但以上场景仍需要以脚本兜底或人工补充。
- 后续迭代有明确的补全清单。
- 文档与 PR 评论需注明这些已知差异，避免用户误判“完全替代”。
