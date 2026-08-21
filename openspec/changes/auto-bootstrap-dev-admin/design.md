## Context

`devtool.sh` 已提供 `bootstrap admin` 子命令，并以开发模式运行既有 CLI；但 `start core` 没有调用它。核心 CLI 的管理员引导已具备幂等创建、RBAC 赋权及配置密码支持。

## Goals / Non-Goals

**Goals:**

- 使常规开发启动在缺失管理员时可立即登录。
- 沿用统一的 CLI 与环境变量语义，避免 Shell 层直接操作数据库。

**Non-Goals:**

- 不修改生产部署流程或管理员密码策略。
- 不在服务已运行时执行额外的管理员引导。

## Decisions

- 在 `start_core` 的 `.env` 校验后、启动进程前调用现有 `cmd_bootstrap_admin`。这确保 `start core` 与完整启动拥有一致行为，且失败会阻止后端启动。
- 不传入邮箱或密码参数，由核心 CLI 读取 `.env`。这样保留 `ADMIN_EMAIL` / `ADMIN_PASS` 的唯一配置来源，并让已有管理员判定保持在服务层。
- 增加 Shell 级回归测试，模拟管理员引导命令并验证调用顺序；不依赖实际 Docker 或数据库。

## Risks / Trade-offs

- [每次启动会多一次 CLI 调用] → 引导逻辑是幂等的，且仅在后端尚未运行时执行。
- [缺失或错误的管理员配置会阻止启动] → 这是有意的快速失败，避免出现服务健康但无法管理的开发环境。

## Migration Plan

无需数据迁移。更新脚本后，下一次通过 devtool 启动后端会自动补齐缺失的配置管理员；回退脚本不会影响已创建账号。
