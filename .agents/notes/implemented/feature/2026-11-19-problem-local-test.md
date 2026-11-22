# Agent Note: 新增 noj-cli problem test 本地验题与 noj-judge run-local 入口

Status: implemented

## Problem

模拟赛中 evaluator 写错、测试点没覆盖、LLM 题资源不足等问题都要等题目上线后才
暴露。出题人（含 AI 辅助出题）缺少「不连平台、在本地用 Docker
沙箱端到端跑一遍题包」
的手段，也无法对「满分解得满分、空解/错解得低分」做自动断言，更不能把这种验证放进
CI 作为模板/题包的验收门槛。

## Decision

采用**方案 2：noj-judge 新增本地入口 `run-local`**，`noj-cli problem test [dir]`
只负责「题包 → 生产同款 JudgeTask」，执行交给 judge。详见
`dev-docs/design/problem-local-test.md`。

1. **noj-judge**：
   - 新增 `src/local.rs` 与
     `noj-judge run-local --task <json> --support-package
     <zip> [--artifact <file>] [--allow-network [--network <名称>]]`
     子命令； `main()` 在启动 Worker 前分派，不读 Redis、不进调度，结果 JSON 写
     stdout、 日志写 stderr，退出码 0 完成 / 1 执行失败 / 2 用法错误。
   - 本地文件经 SHA-256 校验包装为 `noj-download://local`，直接调用生产入口
     `judge::runner::evaluate_with_scheduler`（OI / prediction / dual
     同路径分发）； 为此把 runner 的资源租约 Redis 客户端改为 `Option`，Worker
     恒传 `Some`。
   - 网络默认关闭：题目声明联网也会被关闭并给出提示；`--network host` 沿用
     `validate_evaluator_network_mode` 拒绝；非 mock 的 LLM 网关在未
     `--allow-network` 时直接报错。
2. **Evaluator SDK**：`llm.complete` 识别 `mock://` 网关，返回回显最后一条 user
   消息的确定性响应（含 token 用量、模型白名单校验），离线验证 LLM
   题链路与预算； 生产网关地址恒为 http(s)，不会进入该分支。
3. **noj-cli**：
   - `problem test` 流程：lint（失败即停，退出码 1）→ `validateBundleManifest` →
     按 `pack` 规则构建支持包并剥离 `problem.json` / `statement.md` → 逐个解答
     调用 core 的 `prepareJudgeTask`（含界面题参数注入）后执行 `run-local` →
     对照 `--expect` 断言。客观题直接复用 core `judgePaper`（生产同样不经
     judge）。
   - 参数：`--solution <文件|目录>[@名称]`（可重复，缺省发现 `submissions/`）、
     `--expect name<op>score`（缺省读 `submissions/expect.json`）、`--judge-bin`
     （→ `NOJ_JUDGE_BIN` → `PATH`）、`--allow-network`、`--network`、
     `--[no-]llm-mock`、`--llm-gateway` + `--llm-token`、`--json`。
   - 退出码：0 通过 / 1 校验或断言失败 / 2 用法错误（含找不到 noj-judge）。
   - `pack` 排除规则补上 `submission*`（与 `noj.ts` 的 zip 排除一致），参考解答
     不会进入题包。
4. **CI**：`e2e.yml` 新增 `problem-local-test` job，编译
   noj-judge、构建评测镜像， 对 `fixtures/problem-test/*` 跑
   `problem test`，并以 `--expect wrong=100` 断言 负例必须退出
   1。后续出题模板（P0-2 B）在此 job 中追加即可成为验收门禁。
5. 文档：新增 `noj-docs/docs/problemsetters/local-test.md`
   并接入侧栏与快速出题页。

6. **评审加固（Codex gpt-6.2-sol 评审 PR #762 后）**：
   - `run-local` 对 `result_kind=platform_error`（evaluator 崩溃、非法评分等）
     在封套中给出 `error`，CLI 不再把它当作 0 分参与断言；
   - CLI 评测前以 `run-local --help` 探测 judge 版本，探测与执行时把 `REDIS_URL`
     指向不可达地址（探测时 Docker 也指向不存在的 socket）并设超时，
     旧版二进制即使忽略参数启动 Worker 也无法消费队列；
   - SDK mock 按网关地址查询串（`mock://echo?max_calls=&max_tokens=`）执行题目
     预算，超出返回 429 `out_of_usage`，不改动 JudgeTask 契约；
   - `run-local` 遵守 `JUDGE_REQUIRE_ISOLATED_DOCKER`，忽略 `JUDGE_GO_JUDGE_URL`
     （OI 原生题只在本机 Docker 运行），收到 SIGINT/SIGTERM 时按本次实例标签有界
     清理容器；
   - 支持包与 `pack` 共用 `collectBundleEntries` + 文件级
     `shouldExclude`；预测题 只接受单个文件并复用 core
     `validatePredictionFile`。

## Alternatives considered

- **方案 1：noj-cli 直接调用 docker 编排双容器**。只依赖 docker
  CLI、分发更简单， 但需要在 TypeScript 中重写 NDJSON RPC
  编排、超时、结果解析、OI 与 prediction 分支，并复刻 `cap_drop ALL` /
  `no-new-privileges` / 无网等沙箱基线；每次 judge
  协议变更都要双改，本地结果与线上漂移的风险高，违背「本地验题 = 线上评测」的
  初衷。因此否决。
- **以 judge 镜像运行 run-local**：免装二进制，但需把宿主 Docker socket 挂给
  judge 容器，与「不挂宿主 docker
  socket」的安全基线冲突且路径映射复杂，首版不做。
- **CLI 内实现简化版判分（不起容器）**：无法覆盖资源限制、超时与沙箱行为，
  恰恰是线上事故来源，否决。

## Consequences

- 本地验题与线上 Worker 共用任务构造（core）与执行入口（judge），协议改动自动
  生效；代价是出题人需要 `noj-judge` 二进制与本地评测镜像。
- runner 资源租约客户端变为 `Option`，`None` 仅用于 run-local（OI 并发不受跨副本
  租约约束，单机本地验题可接受）。
- LLM 题默认 mock 只验证链路与预算，不代表真实模型效果；真实验证需显式联网并提供
  网关与 token。
- 本地评测镜像需包含新版 SDK 才能使用 mock；更新 SDK 后需重建
  `noj-evaluator-python`。
- 新增 CI job 约增加一次 noj-judge 编译与两次镜像构建（与其他 job 并行）。
