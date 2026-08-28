## Context

仓库已经有生产部署脚本、`docker-compose.prod.yml` 和跨模块 `noj-tests`，但它们分别承担部署或开发/E2E职责，没有统一的 staging 验收入口。生产栈还需要隔离的 Judge Docker socket；真实 HTTPS 入口由外部 TLS 终止层提供。

## Goals / Non-Goals

**Goals:**

- 用单一 Bash 入口串联来源检查、生产镜像构建、Compose 启动、边缘检查和业务 smoke test。
- 复用现有 E2E helper 的认证、导入、评测和重测能力，并为生产镜像名提供 staging 参数。
- 失败时保存不含环境文件和密钥的诊断产物。
- 让发布文档形成可审计的 staging → 人工批准 → Release 顺序。

**Non-Goals:**

- 不在 GitHub-hosted runner 中假设或创建真实生产域名、密钥管理服务或隔离 Docker daemon。
- 不自动发布 Release、不自动批准人工门禁，不修改线上数据恢复或监控策略。
- 不改变现有业务 API 和普通开发 E2E 的默认行为。

## Decisions

- **新增 `scripts/staging/acceptance.sh`。** 该脚本在具备生产依赖的 staging 主机执行，提供 `check`、`build`、`up`、`verify-edge`、`smoke`、`all` 和 `down` 子命令。相比把逻辑塞入 release workflow，它可以复用真实 staging 主机上的外部 TLS 和隔离 Docker socket。
- **生产 Compose 支持镜像仓库前缀。** 默认继续使用 `ghcr.io/neuro-oj`；staging 可通过变量把候选镜像指向本地标签或测试仓库，避免修改生产文件或推送不可审计的 `latest`。
- **新增专用 staging smoke test。** 使用 `E2E_EVALUATOR_IMAGE` 和 `E2E_SOLUTION_IMAGE` 生成与生产白名单一致的全限定镜像名，避免把普通 E2E 中的本地裸镜像假设带入生产验收。
- **诊断由脚本统一捕获。** 使用 Compose `ps`、最近日志和 commit 元数据；不保存 `.env.prod`、Compose 展开结果或响应中的认证令牌，降低诊断产物泄密风险。
- **发布批准保持人工。** GitHub Release 触发器无法安全推断外部 staging 环境是否已验收，因此用发布清单和验收报告作为人工批准依据，不伪造自动门禁状态。

## Risks / Trade-offs

- [staging 依赖外部基础设施] → 启动前明确检查 HTTPS 地址、生产配置、隔离 Docker socket 和测试账号，文档区分可自动化步骤与人工前置条件。
- [构建六类镜像耗时较长] → 支持 `STAGING_SKIP_BUILD=1` 复用已构建的候选镜像，但默认仍执行构建以保证候选可追溯。
- [业务 smoke test 会写入 staging 数据] → 使用专用测试账号和唯一后缀，测试完成后仅清理测试创建的题目/资源；不对生产环境执行该脚本。
- [外部 TLS/CORS 配置差异导致误报] → 入口检查要求显式提供 staging URL 和允许的 CORS origin；只保存健康响应和状态，不落盘包含 Cookie 的认证响应头。

## Migration Plan

1. 在干净的 `main`、`release/*` 或版本标签工作区准备 `.env.prod` 和隔离 Judge Docker socket。
2. 设置 staging URL、测试管理员凭据及必要的镜像/Compose 变量，运行 `bash scripts/staging/acceptance.sh all`。
3. 检查验收报告和诊断产物；只有成功且完成签名 tag 与人工批准后才发布 Release。
4. 失败时保留诊断目录，修复候选后重新运行；`down` 只删除 staging 容器和网络，不使用 `down -v`。
