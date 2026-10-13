# Agent Note: Judge 集成验证与 prediction 新容器观测

Status: implemented

## Problem

main 增加 prediction 单容器评分和 UI 模式配置，工作空间升级仍需保留 Rust
评测契约及 OI 能力。集成代码需要实际编译、全目标测试和对应 Docker 评测证据。

prediction 既有门禁按 Evaluator
标签列出包括已退出容器的全部对象，仅检查列表非空。本机有两只 9 月 24 日的已退出
Evaluator，它们能满足该正向观测，削弱“本次确实运行 Evaluator”的断言。Solution
基线为空及真实 6666 分评分仍有效，不能因此把整场评测描述成未运行。

## Decision

在隔离集成工作区按模块标准入口运行 Rust
验证，不修改业务源码、Cargo.lock、运行栈或备份项目。仅增强
`tests/e2e_prediction.rs`：保存执行前的 Evaluator
IDs，运行期正向观测必须出现不在该基线中的 ID；保留 Solution
全程及最终不存在的断言。没有删除旧容器或扩大测试权限。

```bash
cd noj-judge
cargo nextest run --all-targets --locked
cargo fmt --all -- --check
cargo clippy --all-targets --locked -- -D warnings
NOJ_RUN_E2E=1 cargo test --locked --test e2e_prediction -- --ignored --nocapture
cargo clippy --test e2e_prediction --locked -- -D warnings
```

## Alternatives considered

- 删除已有 Evaluator 再运行：改变测试宿主的历史资源，也掩盖错误的观测逻辑。
- 将标签检查去掉，只断言分数：保留实际评分证据，但丢掉 prediction 不创建
  Solution 的结构验收。
- 为测试扩大业务源码或改动现有
  Worker：本次缺陷仅在测试基线处理，无需改变评测实现。

## Consequences

标准 nextest 实际通过 631 项、0 项失败，46 项按既有门控跳过。全目标格式和 clippy
检查通过。增强正向观测后，仅复跑对应 Docker 用例，实际 1 passed、0 failed、0
ignored，耗时 3.88 秒；最终该测试的 clippy 也通过，没有重复全量 631 项。

真实 Docker 用例注入 CSV 与三个隐藏标签，得到 6666
分，保留三个测试结果及隐藏标记。运行期观察到此次新增 Evaluator，Solution
基线、全程与最终均为空。独立 Docker event 记录进一步确认本次 Evaluator
`6f6947700af44366c4f7db9f8709e2bf07f44669a4d1ef15bda6240a9e9b5a9d` 的
create、start、脚本 exec 和 destroy，且同一测试 instance 没有 Solution
事件；两只旧 Evaluator 仍保留。

证据日志：`/tmp/noj-client-integration-judge-nextest.log`、`/tmp/noj-client-integration-judge-prediction-docker-final.log`、`/tmp/noj-client-integration-judge-clippy.log`、`/tmp/noj-client-integration-judge-prediction-clippy-final.log`、`/tmp/noj-client-integration-judge-prediction-event-summary.log`。

Docker 测试使用本机既有 E2E daemon，非生产专用 rootless
daemon；不声明生产沙箱部署验收。它直接验证当前 Rust prediction 路径，不包含 core
HTTP、UI 浏览器或新生产镜像全链路。这些范围由协调发布验收分别覆盖。
