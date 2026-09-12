# Agent Note: 生产 Compose 补资源上限/日志轮转与可选 monitoring profile

Status: implemented

## Problem

三个 compose 文件对 `mem_limit|cpus|deploy:|resources:|ulimits` 零命中，`x-default-logging` 只被 `migrate`/`core` 引用 → 单机部署最常见、最致命的两类故障（OOM 杀掉 postgres、日志打满磁盘导致全站写入失败）都没有防线。同时 `setup.sh`/`noj-cli` 对 `prometheus|alertmanager` 零命中——**一键安装产出的系统没有任何监控**，而 `deploy/monitoring/` 下的告警规则与 runbook 又都齐全。另外 `.env.prod.example` 里 `RUNTIME_LLM_GATEWAY_URL` 被注释掉，其默认值写的是开发编排的 container_name `noj-llm-gateway`，生产服务名是 `llm-gateway`（不解析）。

## Decision

1. 10 个服务全部补 `mem_limit`（可用 `*_MEM_LIMIT` 覆盖）+ `logging: *default-logging`（json-file 50m×5）。
2. 新增 `--profile monitoring`：prometheus + alertmanager（镜像 digest 钉死、端口默认只绑 `127.0.0.1`、加载 `noj-alerts.yml`/`noj-slo-alerts.yml`、数据卷持久化）。alertmanager 需真实投递配置（复制 `.example`），缺失即 fail-fast 而不是静默丢告警；`deploy/monitoring/README.md` 增补该路径。
3. core 环境显式设 `RUNTIME_LLM_GATEWAY_URL=http://llm-gateway:8001` 与 `RUNTIME_JUDGE_MODE`，并在 `.env.prod.example` 说明它与 `NOJ_LLM_GATEWAY_URL`（出站 LLM 调用地址）**用途不同**。
4. **judge 不加 healthcheck**，原因写入 compose 注释：它是纯 worker，没有 HTTP/心跳面，失败模式是进程退出（`restart: unless-stopped` 已覆盖）；加 `CMD true` 式探针只会制造"绿但无用"的假信号。真正的存活/积压观测走 Prometheus 指标与告警规则。

## Alternatives considered

- 给 judge 加假探针：与本次评审要消除的"假绿灯"同类，明确否决。
- 用 `deploy.resources.limits`：那是 swarm/K8s 语义，单机 compose 用 `mem_limit` 才生效。
- 默认启动监控栈：会让最小部署多出两个容器与端口暴露面，改为 opt-in profile。
- 把 alertmanager 配置内置进仓库：投递凭据不应入库（现有 README 已明确）。

## Consequences

一键部署默认获得资源与日志防线；需要监控时一条命令启动。`docker compose config`（含两个 profile）校验通过。judge 的容器级探针作为已知缺口留给下一轮（需先在 judge 内实现"Redis 可达 + 无卡死任务"的自检子命令）。
