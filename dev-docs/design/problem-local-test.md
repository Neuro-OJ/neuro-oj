# 设计说明：`noj-cli problem test` 本地验题（方案选型）

> 状态：已采纳（2026-11-19） · 关联：P0-2 出题提效 A · Agent Note：
> `.agents/notes/implemented/feature/2026-11-19-problem-local-test.md`

## 背景

模拟赛中暴露的问题：evaluator 写错、测试点没覆盖、LLM 题资源不足，都要等题目上线
后才发现。出题人需要在**不连平台**的前提下，用 Docker 沙箱把题目包跑一遍，并对
「满分解得满分、空解/错解得低分」做断言。

## 候选方案

| 维度            | 方案 1：noj-cli 直接编排 docker              | 方案 2：noj-judge 新增本地入口 `run-local`       |
| --------------- | -------------------------------------------- | ------------------------------------------------ |
| 协议一致性      | 需在 TS 中重写 NDJSON 编排、超时、结果解析   | 与生产同一入口 `evaluate_with_scheduler`，零重写 |
| 沙箱安全基线    | 需复刻 `cap_drop`/`no-new-privileges`/无网等 | 直接复用 `sandbox/host_config.rs`                |
| OI / prediction | 需各写一套                                   | 与生产同路径分发                                 |
| 依赖            | 只要 docker CLI                              | 需要 `noj-judge` 二进制（或其镜像）              |
| 维护成本        | 每次 judge 协议变更都要双改，漂移风险高      | judge 改动自动生效                               |

## 决策：方案 2

`noj-cli problem test` 只负责「题包 → 生产同款 JudgeTask」，执行交给
`noj-judge run-local`：

```text
noj-cli problem test <dir>
  ├─ lint（失败即停，退出码 1）
  ├─ validateBundleManifest()  ← noj-core，补全 runtime_config 平台缺省值
  ├─ 支持包 = pack 规则打包后剥离 problem.json / statement.md（与导入一致）
  ├─ 每个参考解答：
  │    ├─ objective：noj-core judgePaper() 直接判分（生产同样不经 judge）
  │    └─ 其余：prepareJudgeTask() ← noj-core，生成生产同款 JudgeTask（含 ui 脚本注入）
  │           └─ noj-judge run-local --task t.json --support-package s.zip [--artifact a]
  │                 └─ judge::runner::evaluate_with_scheduler()  ← 与 Worker 同一入口
  └─ 对照 --expect 断言（0 通过 / 1 断言失败 / 2 用法或环境错误）
```

要点：

1. **任务构造复用 core**：`prepareJudgeTask` / `buildUiSolutionScript` /
   `validateBundleManifest` 都是无 DB 依赖的纯函数，CLI 直接 import（与现有
   `lint` 的复用方式一致），避免 CLI 与 core 两份任务构造逻辑漂移。
2. **执行复用 judge**：`run-local` 不连 Redis、不走调度，只读一个 JudgeTask
   JSON， 把本地文件包装成 `noj-download://local`（附 SHA-256）后调用
   `evaluate_with_scheduler`，结果 JSON 写到 stdout，日志走 stderr。
3. **安全约束不放宽**：容器仍由 `host_config` 构造（`cap_drop ALL`、
   `no-new-privileges`、`network_mode none`、不挂宿主 docker socket）；
   镜像前缀与命令白名单照常复验。
4. **网络默认关闭**：题目声明了 `evaluator.network.enabled` 也会被 `run-local`
   关掉并给出提示，只有显式 `--allow-network [--network <名称>]` 才联网。
5. **LLM 题离线验题**：`--llm-mock` 下 judge 注入
   `NOJ_LLM_GATEWAY_URL=mock://echo`，`noj_evaluator_sdk.llm` 识别后返回确定性
   回显响应，不联网、不消耗额度，用于验证预算、capability 封装与结果解析链路；
   真实效果用 `--llm-gateway <url> --llm-token <token>`（必须同时
   `--allow-network`）。 生产网关地址只来自 core 配置，恒为 http(s)，不会误入
   mock 分支。

6. **结果可信**：平台错误（`result_kind=platform_error`）不计分、断言直接失败；
   预测题复用 core 上传校验；支持包与 `pack` 共用文件收集与排除逻辑。
7. **不外发、不残留**：忽略 `JUDGE_GO_JUDGE_URL`，遵守
   `JUDGE_REQUIRE_ISOLATED_DOCKER`；中断时按本次实例标签清理容器；CLI 先探测
   `run-local` 支持情况，旧版 judge 无法被误启动成消费队列的 Worker。

## 不做什么

- 不在 CLI 中实现任何容器编排或评测协议解析。
- 不新增 judge 的生产配置项；`run-local` 是独立子命令，Worker 主循环不受影响。
- 首版只支持 `noj-judge` 二进制（`--judge-bin` / `NOJ_JUDGE_BIN` / `PATH`）； 以
  judge 镜像运行（需挂 docker socket 给 judge 自身）留作后续。
