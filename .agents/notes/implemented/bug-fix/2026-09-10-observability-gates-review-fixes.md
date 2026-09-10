# Agent Note: 观测门禁与告警配置的评审修复

Status: implemented

## Problem

可观测性域重构（见 [可观测性平台域重构](../architecture/2026-09-10-observability-domain.md)）
落地后，多道门禁在**坏输入下静默通过**，使若干缺陷长期不被发现：

- `test-monitoring.sh` 的 runbook 锚点循环从 `noj-alerts.yml` 提取 `observability.md#<锚点>`
  再校验，但从未断言提取结果非空。运维告警一度被生成器整体覆盖，该循环在零输入下
  仍打印 `✓`。
- `check-runbooks_test.ts` 与 `check-runtime-contract_test.ts` 只断言
  `Array.isArray(errors)`，对任何输入恒真。
- `check-metrics.ts` 的 `WRITE_RE` 要求指标名后紧跟 `)`，只能匹配无第二参数的写入；
  带标签/带增量这种真实调用形态全部漏检。
- `check-runbooks.ts` 只 `stat` runbook 路径存在性，从不校验锚点；`test-monitoring.sh`
  又只扫 `noj-alerts.yml`，于是 3 条 email 告警的注解从未被任何检查覆盖。

由此产生并存的实质缺陷：

- `noj-alerts.yml` 的 20 条注解指向仓库根 `docs/operators/observability.md`，而该文件
  没有任何 `{#...}` 锚点，全部为死链；两个检查器各自校验不同的文件，因此都通过。
- `noj-llm-gateway` 给 `RedisClient` 增加必需成员 `ping()` 后未同步测试替身，
  `deno check tests/*.ts` 产生 16 个错误。模块默认 `test` 任务带 `--no-check` 掩盖了它，
  只有 `test:coverage`（CI 的 `coverage-check` 作业，门禁 push 到 main）类型检查失败。
- `queue_oldest_judging_age` 同时存在于两侧：运维告警 `NojStaleJudging` 与 SLO 告警
  `NojSloQueueOldestJudgingAge` 条件、保持时长、级别相同，同一故障会产生两个
  Alertmanager 分组与两本 runbook。
- `burnRateWindows` 名为双窗口，实际只把 `long` 当作 `for:` 保持时长；两条告警表达式与
  阈值完全相同，`Fast` 被 `Slow` 严格蕴含。
- `prometheus.yml` 的网关抓取目标写作 `noj-llm-gateway:8001`，而
  `docker-compose.prod.yml` 的服务名是 `llm-gateway`（无 `container_name`、无别名），
  生产该 job 静默无数据。

## Decision

把门禁从「有检查」改为「检查到东西」，并修复由此暴露的配置缺陷：

- **门禁非空化**：`checkRunbooks` 在零注解时返回错误而非空数组，错误信息带来源文件；
  `test-monitoring.sh` 的空输入守卫、按注解声明的文件定位锚点（而非写死一个文件）、
  并要求目标文档存在；两个 check 测试改为断言具体诊断输出。
- **`checkRunbooks` 零注解即失败**，因为注解被整体清空与「检查逻辑失配」不可区分。
- **`WRITE_RE` 锚定到指标名字符串**，不要求后接 `)`，覆盖带标签/带增量的写入。
- **删除 SLO 侧的 `queue_oldest_judging_age`**，该条件由运维告警 `NojStaleJudging`
  单独负责；`test-monitoring.sh` 增加反向断言防止重复告警回归。
- **`burnRateWindows` 更名为 `holdFor`**，并在 `slo.ts` 注释与运维文档中写明当前是
  单窗口燃烧率：`burn_rate > 1` 等价于 SLI 自身窗口内 `SLI < objective`，`Fast` 被
  `Slow` 蕴含，评估敏感度须以 SLI 表达式窗口为准。
- **抓取目标改为 `llm-gateway:8001`**，并在 `test-monitoring.sh` 增加断言：所有
  `noj-*` 任务的目标主机名必须是 `docker-compose.prod.yml` 的服务名。
- **SLO 规则装载可观测**：`noj-alerts.yml` 新增 `NojSloRulesMissing`
  （`absent(noj:slo:api_availability:burn_rate)`，30m，critical）。实测
  Prometheus v2.54.1 在 `rule_files` 指向缺失文件时照常启动且不报错，整组 SLO 规则
  静默消失，该告警覆盖这一失败；README 与两份运维文档补充两文件安装步骤与
  `promtool check config` 校验。

## Alternatives considered

- **只修缺陷、不动门禁**：改动更小，但同类缺陷会再次静默通过——本节列出的 5 个缺陷
  全部是「门禁绿 + 配置坏」的组合，只修配置不修门禁等于保留复发条件。
- **让 `ping` 成为可选成员**（`ping?(): Promise<string>`）：改动更小，但就绪探针调用
  可选方法语义别扭；选择给两个替身补实现，保持接口表达真实契约。
- **为 `queue_oldest_judging_age` 保留 SLO 侧告警**：需要删除运维侧条目并同步文档与
  门禁断言，且阈值型 gauge 没有错误预算语义，因此保留运维告警。
- **实现真正的多窗口多燃烧率（MWMBR）**：需要长短窗口同时越限、阈值由错误预算推导，
  涉及生成器、类型、测试与全部 SLO 的重新调参；本轮只做改名与文档澄清，MWMBR 留作
  后续工作。
- **`false` 兜底而非守卫**：让零注解静默通过并在文档说明，被否决——这正是问题本身。

## Consequences

- `check-ci.ts` 全绿不再等于配置正确，但零注解、缺锚点、缺文件、抓取目标不匹配、
  重复告警这些形态现在都会显式失败。
- `check-metrics.ts` 覆盖的写入点从 6 个增至 19 个，带标签的写入不再漏检。
- 运行 `deno run -A scripts/gen-alert-rules.ts` 会按 `slo.ts` 重新生成 SLO 规则；
  运维告警仍在 `noj-alerts.yml` 手工维护，生成器不再触碰该文件。
- `plan`/`spec` 文档中的 `burnRateWindows` 与计划命名 `NojSloBurnRate*` 未回改——它们
  是历史计划记录，与当前代码不一致属预期；以 `slo.ts` 为准。
- 抓取目标改名为 `llm-gateway` 后，若将来给该服务加 `container_name` 或网络别名，
  需同步 `prometheus.yml`，否则新断言会失败——这是有意的耦合提示。
- `NojSloRulesMissing` 自身依赖 SLO 记录规则不存在来触发；若 `noj-alerts.yml` 整体
  未安装，则该看门狗与其保护的对象一同消失，此边界无法在规则文件内消除。
