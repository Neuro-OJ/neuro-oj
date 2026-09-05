# 生产监控部署与告警投递

本目录提供 Prometheus 抓取配置（`prometheus.yml`）、告警规则（`noj-alerts.yml`）、
Alertmanager 配置模板（`alertmanager.yml.example`）与 Grafana 仪表盘（`grafana-dashboard.json`）。

## 1. 组件与网络

推荐在宿主机以独立容器运行 Prometheus / Alertmanager / node_exporter，
并把 Prometheus 与 Alertmanager 加入生产内部网络 `noj-net`：

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

凭据注入：**凭据不入库**。`alertmanager.yml.example` 中的 `${...}` 占位符用 `envsubst`
渲染成 `/etc/alertmanager/alertmanager.yml`（权限 600，仅部署环境保留），见文件头注释。
渲染后可用 `amtool check-config /etc/alertmanager/alertmanager.yml` 校验。

## 2. node_exporter 与备份新鲜度指标

`noj-alerts.yml` 中的备份/演练新鲜度告警依赖 textfile 指标：

- `scripts/deploy/backup.sh create` 写出 `<备份目录>/metrics/noj_backup.prom`
  （`noj_backup_last_success_unix_time`、`noj_backup_snapshot_bytes`）。
- `scripts/deploy/restore-drill.sh` 写出 `<备份目录>/metrics/noj_restore_drill.prom`
  （`noj_restore_drill_last_success_unix_time`）。

宿主机 node_exporter 通过 textfile collector 采集这些文件，Prometheus 抓取后告警生效：

```bash
# textfile 目录必须包含备份指标目录（可用 bind mount 汇聚多个来源）
docker run -d --name noj-node-exporter \
  --network noj-prod_noj-net \
  -v /opt/neuro-oj/backups/metrics:/var/lib/node_exporter/textfile:ro \
  prom/node-exporter:v1.8.2 --collector.textfile.directory=/var/lib/node_exporter/textfile
```

然后取消 `prometheus.yml` 中 `job_name: node` 段的注释并重载 Prometheus。
未启用 node_exporter 时，备份/演练新鲜度告警不会触发，请在容量规划中记录这一限制。

## 3. 告警投递演练（上线前必须执行一次）

规则文件只能产生告警，**不能证明有人收到**。每次部署或调整接收器后，执行一次投递演练：

```bash
bash scripts/deploy/test-alert.sh http://alertmanager:9093
```

脚本会向 Alertmanager 注入一条 `NojNotificationDrill` 测试告警（critical 与 warning 各一条），
接收方应同时收到触发与恢复（resolved）通知。演练结果按下表记录（保留在本仓库外或运维手册）：

| 日期 (UTC) | 演练人 | 告警条数 | 预期接收方 | 实际收到时间 | 恢复通知收到时间 | 结果 |
|---|---|---|---|---|---|---|
| 2026-09-05T10:00Z | （示例）张三 | 2 | ops@example.com | 10:01Z | 10:06Z | 通过 |

## 4. 验证清单

- [ ] Prometheus targets 页面中 `noj-core`（及可选 `node`）为 UP。
- [ ] `amtool check-config` 通过，Alertmanager 日志无加载错误。
- [ ] 执行过至少一次 `scripts/deploy/test-alert.sh` 且接收方确认收到触发与恢复通知，并已记录。
- [ ] Runbook 链接（noj-alerts.yml 中的 `runbook` 注解）能定位到对应处理步骤。
- [ ] 备份 cron 运行后 textfile 目录中出现 `noj_backup.prom`。
