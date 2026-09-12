# 公测容量基线

本文定义低并发公测的可重复容量验收方法。它不是所有部署环境的固定承诺；更换硬件、镜像、题型、
Judge 并发或 LLM Provider 后，应重新执行。

## 固定测试条件

每次报告至少记录以下字段：

| 类别 | 必填内容 |
| --- | --- |
| 版本 | Git 提交或 Release、镜像 digest、数据库迁移版本 |
| 主机 | Linux 发行版、CPU 核数、内存、Swap、磁盘和 Docker 存储可用量 |
| 服务 | PostgreSQL/Redis/MinIO/Nginx/core/UI/Judge 是否同机 |
| 评测 | 题型、Evaluator/Solution 镜像、单任务 CPU/内存/时间限制、Judge 并发 |
| 流量 | 注册/登录、题目读取、提交、结果回写、榜单读取的请求速率与持续时间 |
| LLM | Provider、并发、P50/P95 延迟、限额、错误率；未启用时明确写“未启用” |

测试不得使用正式用户数据、正式比赛成绩或仓库中的隐藏题目包。评测数据应使用专用验收题，
并确保其结果不会计入正式赛事。

## 验收场景

按以下顺序执行，并分别记录 P50/P95、失败率、队列等待、CPU/内存/磁盘峰值：

1. 基线：单用户完成登录、题目读取、提交和结果查询。
2. 集中提交：固定并发用户在固定时间内重复提交验收题。
3. 结果洪峰：让提交集中完成，观察结果回写和榜单读取是否积压。
4. 批量重测：在低优先级维护窗口执行批量重测，记录对普通提交的影响。
5. 过载：逐步提高提交速率，记录开始排队、拒流、超时和恢复的阈值。

启用 LLM 时增加 Provider 延迟、限额耗尽和 Provider 错误场景；启用独立 Judge 时分别记录主站和
Judge Worker 的资源峰值。测试结束后确认队列归零、失败任务可解释、对象和日志没有异常增长。

## 报告模板

复制以下模板保存到脱敏的验收记录中：

```text
result=passed|passed_with_warnings|failed
tested_at=YYYY-MM-DDTHH:MM:SSZ
version=
image_digests=
migration_version=
host_os=
cpu=
memory_gib=
swap_gib=
disk_free_gib=
docker_free_gib=
judge_location=same-host|separate-worker|disabled
judge_concurrency=
problem_fixture=
request_rate_per_second=
duration_minutes=
p50_ms=
p95_ms=
queue_wait_p95_ms=
cpu_peak_percent=
memory_peak_gib=
disk_peak_gib=
failure_rate_percent=
llm_provider=disabled|provider-name
llm_p95_ms=
llm_error_rate_percent=
recommended_public_scale=
scale_up_trigger=
overload_behavior=
recovery_notes=
```

报告结论至少应说明：该环境建议开放的并发规模、扩容触发条件、过载时的排队/拒流表现、已知限制和
失败恢复步骤。没有实际压测数据时，不得把“仅能启动/诊断”写成“可承载公测”。
