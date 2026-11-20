# Agent Note: 标准 E2E 上游模型证据与 Browser CI 环境

Status: implemented

## Problem

Domain 模型治理 Browser 旅程在独立集成栈已真实通过，但标准 Compose 的旧 LLM Mock
丢弃请求正文，没有模型回显或只读记录。Browser CI 若仍使用旧 Mock，就无法独立证明
Gateway 转发了正确的冻结模型。

## Decision

- 将标准 E2E LLM Mock 从 Compose 内联 Python
  抽为独立脚本，由容器只读挂载，仍监听 8002。
- 成功响应保留 `ok`、`choices` 和原有 5+3=8 Token 用量，新增 `model`
  回显实际请求模型。`/health` 保留 `{ "ok": true }`。
- GET `/` 仅返回 `ok` 与
  `requests[{path,model}]`，读取不增加记录。不存储请求头、密钥或提示正文，路径去除查询参数。
- 增加临时端口上的真实 HTTP 契约检查，由 composite action 在起栈前执行。Mock
  的请求列表仅用于这个测试进程；不作为生产计数、配置或审计来源。
- Browser CI 显式提供当前 E2E 数据库用于只读受理快照核对、Mock 容器内 Provider
  地址及主机侧检查地址。没有修改业务 core 或正式生产工作流。

## Alternatives considered

- 仅断言 Gateway 用量账本，无法独立验证真正的上游模型，没有采用。
- 完整记录 LLM 请求会泄露密钥、提示或其他私有信息，没有采用。
- 为 Browser 旅程额外启动另一套上游会使标准 CI 与已验证流程分叉，没有采用。相同
  Mock 提供评测响应与最小检查证据。
- 重启现有测试 Mock
  会影响其他验收，没有采用。仅启动临时独立容器检查标准脚本，随后停止并删除。

## Consequences

2026-10-13 实际验证：

- `python3 -B scripts/e2e/check_llm_mock.py`：1 test / 0
  failures。验证健康响应、模型与用量回显、仅路径/模型记录、重复 GET
  不改变记录，以及请求头、正文和查询参数不出现在读取结果。
- 标准 `docker compose -f docker-compose.e2e.yml config --quiet` 通过。
- 使用 `python:3.12-slim`
  在临时独立端口启动相同脚本，实际请求健康、完成及记录入口，响应符合契约。Docker
  检查脚本挂载 `writable=false`；临时容器已停止并自动删除。
- `bash scripts/e2e/check-setup.sh` 通过，包括 SDK
  构建失败传播与项目名隔离检查。
- 修改的 YAML 格式检查、Python AST 检查和外部 Action 固定引用检查通过。

本批接通标准 Browser CI 的必需环境，并提供本地可复现的 Mock 契约门禁；GitHub CI
本身仍需由主 agent 提交后运行，本记录不声称远端 CI 已通过。
