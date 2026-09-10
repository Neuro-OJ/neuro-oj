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
- `check-metrics.ts` 的 `WRITE_RE` 把接收者写死为 `observability` 字面量
  （`/observability\.(?:inc|set|add|observe)\(/`），而生产代码的写入接收者实际写作
  `metrics`（`// @ts-...` 别名）、`registry`、`observabilityRegistry` 等，因此该门禁
  在生产代码上**几乎完全失效**：实测基线只匹配到 **1** 个写入点。
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
- **`WRITE_RE` 改为锚定指标名前缀**（`/\.(?:inc|set|add|observe)\(\s*"(noj_[a-z0-9_]+)"/`）：
  不再枚举接收者变量名，因此覆盖全部接收者形态；`noj_` 前缀由
  `validateMetricDefinition` 强制，且定义处写作 `name: "..."`，不会误匹配。
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
- `check-metrics.ts` 覆盖的写入点由 1 个增至 20 个（`noj-core/src` 非测试代码），
  任意接收者变量名的写入都在检查范围内。
- 运行 `deno run -A scripts/gen-alert-rules.ts` 会按 `slo.ts` 重新生成 SLO 规则；
  运维告警仍在 `noj-alerts.yml` 手工维护，生成器不再触碰该文件。
- `plan`/`spec` 文档中的 `burnRateWindows` 与计划命名 `NojSloBurnRate*` 未回改——它们
  是历史计划记录，与当前代码不一致属预期；以 `slo.ts` 为准。
- 抓取目标改名为 `llm-gateway` 后，若将来给该服务加 `container_name` 或网络别名，
  需同步 `prometheus.yml`，否则新断言会失败——这是有意的耦合提示。
- `NojSloRulesMissing` 自身依赖 SLO 记录规则不存在来触发；若 `noj-alerts.yml` 整体
  未安装，则该看门狗与其保护的对象一同消失，此边界无法在规则文件内消除。

## 复审修复（第二轮）

对本轮改动做独立代码复审后，修掉了 6 处「门禁自身不可靠」的缺陷——它们与本节开头
列出的缺陷属**同一类**，包括本轮新写的门禁：

- **抓取目标门禁自己就是假绿**：初版 awk 不重置 `job` 变量，导致非 `noj-*` 任务沿用上一个
  `noj-*` 任务名——按文档取消 `job_name: node` 注释会被误拦（错误信息还会指向错误的任务名）；
  同时 `gsub(/[[:space:]]+/, "", line)` 把多个目标粘成一个 token，只校验第一个，块状多行
  `targets:` 更因无 `]` 而整段跳过。已重写为状态机（重置 job、按逗号拆多目标、支持块状、
  零目标即失败），并用 4 个变异探测验证。
- **`NojSloRulesMissing` 会把原因误判**：`absent(数据相关录制规则)` 无法区分「规则组未装载」
  与「录制规则产出空向量」——后者在核心停机或无流量窗口内必然发生（实测：规则已装载时
  `absent(noj:slo:api_availability:burn_rate)` 仍为 1）。改为生成器恒定输出哨兵
  `noj:slo:rules_loaded = vector(1)`，告警改用 `absent(noj:slo:rules_loaded)`；实测装载时
  哨兵存在、absent 为空。
- **`check-metrics.ts` 的正则仍漏检接收者**：按接收者枚举必然列不全（`observabilityRegistry`
  即漏网，而 `app.ts` 正是该写法）。改为锚定 `noj_` 指标名前缀。
- **`/healthz` 信息披露回归**：`/health/ready` 新增的 `database`/`redis`/`consumer`/`queue`
  四字段被无条件输出，绕过了 `showDetails` 生产守卫，而该端点经 nginx 无鉴权暴露。
  已移入守卫并补生产环境用例。
- **`scripts/` 不在 CI 的 lint/fmt 范围内**：本节新增的门禁逻辑大多在 `scripts/`，而
  `.github/workflows/ci.yml` 只对 `noj-core` 与 `noj-llm-gateway` 跑 `deno lint`/`fmt`。
  残留的未使用参数（`isPublicDomainImport` 的 `sourceDomain`）因此只在本地暴露。
  本轮已清理该参数并本地对 `scripts/` 全量 lint；给 CI 补 `scripts/` 检查列为后续工作。
- **spec §6 的反向断言未实现**：改为新增 `checkAdminObservabilityReadSide`——admin 是聚合
  门面、`domainOf` 返回 null，通用规则覆盖不到它，这条不变量（admin 不得导入观测域读侧）
  必须单独表达；同时删掉之前两条重复/空洞的 fixture（其一路径写成 `../../observability/`
  会解析到不存在的域内路径，断言恒真）。
