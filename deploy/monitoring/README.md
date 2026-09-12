# 生产监控部署与告警投递

本目录提供 Prometheus
抓取配置（`prometheus.yml`）、运维告警规则（`noj-alerts.yml`）、SLO 告警规则
（`noj-slo-alerts.yml`）、Alertmanager 配置模板（`alertmanager.yml.example`）与
Grafana 仪表盘（`grafana-dashboard.json`）。

## 1. 组件与网络

### 1.1 推荐：使用 compose 的 monitoring profile（2026-09-12 起）

生产 compose 已内置 Prometheus + Alertmanager 的可选 profile，无需手工 run 容器：

```bash
# 1) 准备告警投递配置（缺失时 alertmanager 会 fail-fast，不会静默丢告警）
cp deploy/monitoring/alertmanager.yml.example deploy/monitoring/alertmanager.yml
$EDITOR deploy/monitoring/alertmanager.yml

# 2) 启动（可与 --profile judge 组合）
docker compose --env-file .env.prod -f docker-compose.prod.yml \
  --profile monitoring up -d
```

- Prometheus 通过 `deploy/monitoring/prometheus.yml` 抓取 `core:8000` 与
  `llm-gateway:8001`，并加载 `noj-alerts.yml` / `noj-slo-alerts.yml`。
- 端口默认只绑 `127.0.0.1`（`PROMETHEUS_BIND` / `ALERTMANAGER_BIND` 可覆盖），
  避免未加认证的指标端点暴露到公网。
- 资源上限与日志轮转随 profile 一并生效（`PROMETHEUS_MEM_LIMIT` 等）。

### 1.2 备选：宿主机独立容器

也可以在宿主机以独立容器运行 Prometheus / Alertmanager / node_exporter， 并把
Prometheus 与 Alertmanager 加入生产内部网络 `noj-net`：

```bash
docker network inspect noj-prod_noj-net   # 确认生产网络名
docker run -d --name noj-alertmanager \
  --network noj-prod_noj-net \
  -v /etc/alertmanager/alertmanager.yml:/etc/alertmanager/alertmanager.yml:ro \
  prom/alertmanager:v0.27.0
docker run -d --name noj-prometheus \
  --network noj-prod_noj-net \
  -v /etc/prometheus:/etc/prometheus:ro \
  prom/prometheus:v2.54.1
```

凭据注入：**凭据不入库**。`alertmanager.yml.example` 中的 `${...}` 占位符用
`envsubst` 渲染成 `/etc/alertmanager/alertmanager.yml`（权限
600，仅部署环境保留），见文件头注释。 渲染后可用
`amtool check-config /etc/alertmanager/alertmanager.yml` 校验。

## 2. 抓取目标

- `noj-core`：`core:8000/metrics`（内部网络）。
- `noj-llm-gateway`：`llm-gateway:8001/metrics`（内部网络；由网关 `/metrics`
  暴露）。目标名必须与 `docker-compose.prod.yml` 的服务名一致——服务名即
  `noj-net` 内的 DNS 名；`noj-llm-gateway` 只是开发编排中的 `container_name`，
  生产不解析，写错会让该 job 静默无数据。
- `node`（可选）：宿主机 node_exporter，含备份/演练 textfile 指标。

## 3. 规则文件安装与校验

Prometheus 的 `rule_files` 引用了**两个**文件，两者都必须安装到
`/etc/prometheus/rules/`：

- `noj-alerts.yml`：运维告警（手工维护，**不要**用生成器覆盖）。
- `noj-slo-alerts.yml`：SLO 燃烧率告警，由 `slo.ts` 生成，勿手工编辑。
  重新生成：`deno run -A scripts/gen-alert-rules.ts`；
  校验无漂移：`deno run -A scripts/gen-alert-rules.ts --check`。

```bash
install -d /etc/prometheus/rules
install -m 644 deploy/monitoring/noj-alerts.yml     /etc/prometheus/rules/
install -m 644 deploy/monitoring/noj-slo-alerts.yml /etc/prometheus/rules/
promtool check config /etc/prometheus/prometheus.yml   # 会明确指出缺失的规则文件
```

> **缺失规则文件不会让 Prometheus 启动失败。** 实测 v2.54.1：`rule_files` 指向
> 不存在的文件时服务器照常启动并打印 `Server is ready`，**不报错也不告警**，
> 结果是整组 SLO 规则静默消失。因此必须用 `promtool check config` 校验，
> 并确认 Prometheus 的 `/rules` 页面同时列出 `noj-production` 与 `noj-slo` 两组。
> `noj-alerts.yml` 中的 `NojSloRulesMissing` 是这一丢失的看门狗。

## 4. node_exporter 与备份新鲜度指标

`noj-alerts.yml` 中的备份/演练新鲜度告警依赖 textfile 指标：

- `scripts/deploy/backup.sh create` 写出 `<备份目录>/metrics/noj_backup.prom`
  （`noj_backup_last_success_unix_time`、`noj_backup_snapshot_bytes`）。
- `scripts/deploy/restore-drill.sh` 写出
  `<备份目录>/metrics/noj_restore_drill.prom`
  （`noj_restore_drill_last_success_unix_time`）。

宿主机 node_exporter 通过 textfile collector 采集这些文件，Prometheus
抓取后告警生效：

```bash
# textfile 目录必须包含备份指标目录（可用 bind mount 汇聚多个来源）
docker run -d --name noj-node-exporter \
  --network noj-prod_noj-net \
  -v /opt/neuro-oj/backups/metrics:/var/lib/node_exporter/textfile:ro \
  prom/node-exporter:v1.8.2 --collector.textfile.directory=/var/lib/node_exporter/textfile
```

然后取消 `prometheus.yml` 中 `job_name: node` 段的注释并重载 Prometheus。 未启用
node_exporter 时，备份/演练新鲜度告警不会触发，请在容量规划中记录这一限制。

## 5. 告警投递演练（上线前必须执行一次）

规则文件只能产生告警，**不能证明有人收到**。每次部署或调整接收器后，执行一次投递演练：

```bash
bash scripts/deploy/test-alert.sh http://alertmanager:9093
```

脚本会向 Alertmanager 注入一条 `NojNotificationDrill` 测试告警（critical 与
warning 各一条），
接收方应同时收到触发与恢复（resolved）通知。演练结果按下表记录（保留在本仓库外或运维手册）：

| 日期 (UTC)        | 演练人       | 告警条数 | 预期接收方      | 实际收到时间 | 恢复通知收到时间 | 结果 |
| ----------------- | ------------ | -------- | --------------- | ------------ | ---------------- | ---- |
| 2026-09-05T10:00Z | （示例）张三 | 2        | ops@example.com | 10:01Z       | 10:06Z           | 通过 |

## 6. 验证清单

- [ ] Prometheus targets 页面中 `noj-core`、`noj-llm-gateway`（及可选 `node`）为
      UP。
- [ ] `promtool check config` 通过，且 `/rules` 页面同时列出 `noj-production` 与
      `noj-slo` 两组规则（缺第二组说明 `noj-slo-alerts.yml` 未安装，且不会有任何报错）。
- [ ] `amtool check-config` 通过，Alertmanager 日志无加载错误。
- [ ] 执行过至少一次 `scripts/deploy/test-alert.sh`
      且接收方确认收到触发与恢复通知，并已记录。
- [ ] Runbook 链接（noj-alerts.yml / noj-slo-alerts.yml 中的 `runbook` 注解）能定位到对应处理步骤。
- [ ] 备份 cron 运行后 textfile 目录中出现 `noj_backup.prom`。
