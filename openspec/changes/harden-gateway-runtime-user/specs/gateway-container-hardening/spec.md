## Purpose

确保 LLM Gateway 生产容器以最小权限运行，在不影响现有服务端口和启动方式的前提下减少容器进程获得宿主机资源的风险。

## ADDED Requirements

### Requirement: LLM Gateway 生产容器必须使用非 root 用户

LLM Gateway 生产镜像 MUST 创建并使用专用的非 root 用户运行服务进程，且应用运行目录 MUST 对该用户可读。

#### Scenario: 容器启动用户非 root

- **WHEN** 以正式镜像启动 LLM Gateway 容器
- **THEN** 容器内服务进程的用户 ID MUST 不等于 0，并保持既有启动命令和监听端口可用

#### Scenario: 发布 smoke test 检查非 root

- **WHEN** 正式发布验证执行 LLM Gateway 镜像 smoke test
- **THEN** 镜像 MUST 通过运行用户非 root 和 Deno 可执行文件存在的检查
