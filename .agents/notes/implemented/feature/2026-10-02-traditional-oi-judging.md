# Agent Note: 传统 OI 题评测第一阶段

Status: implemented

## Problem

Neuro OJ 原有任务协议只描述 Python 双容器评测，无法表达传统 OI 题的 C/C++
源码、输入输出测试点、全通过子任务和常见 OI 状态码。题包导入、提交入队和 judge
执行器因此无法共享同一套约束。

## Decision

- 以 `judge_type` 区分 `dual` 与 `oi`；存量没有该字段的任务继续按 `dual` 处理。
- OI runtime 配置声明 `native/wasm` backend、C/C++ 语言、题目/子任务/测试点时空限制、
  `default/strict/testlib` checker 和 DAG 依赖；子任务全部通过才得分，分数总和固定为 100。
- core 在导入、CRUD、提交、自测和重测路径复用 OI 配置校验，并检查题包引用文件和安全路径。
- native OI runner 使用 Worker 固定的 `JUDGE_OI_IMAGE`，每个测试点创建一次性非 root、
  `network_mode=none` 的 Docker 容器，在容器内编译 C17/C++20 并执行；Docker cgroup
  负责 CPU/内存边界，worker 负责输入、输出上限和超时归因。
- OI 细分状态使用 `AC/WA/TLE/MLE/OLE/RE/CE/SE/FE/IGN`，仍封装为现有
  `JudgeResult`，由 core 侧白名单归一。
- WASM 和 testlib checker 暂时保留协议与准入模型，但在没有可信执行器时明确返回 `SE`，
  不回退为宿主执行或把题包中的 checker 当作平台代码执行。
- 校准模块先提供可审计的线性拟合与等效时限换算，模型不接受题目侧任意代码或模型文件。

## Alternatives considered

- 把 OI 题转换成双容器 `evaluate.py`：会重新引入墙钟/脚本协议，无法保证 C/C++ 编译和
  常见 OI 状态码的一致性，因此未采用。
- 在 judge 宿主机直接执行编译器或 checker：安全边界不可接受，因此未采用。
- 让题目消息携带 OI 镜像：会绕过 Worker 的可信镜像配置，因此固定为 `JUDGE_OI_IMAGE`。

## Consequences

- 同一题目的重测读取当前数据库配置和最新支持包，不建立题目版本快照。
- native OI 题可以与 dual 任务共享 Redis 队列和并发调度；每测试点一次容器会增加容器
  创建/编译开销，后续可在不改变协议的前提下加入可信编译缓存。
- WASM instruction-count backend、testlib checker runner 和前端题面编辑器的完整配置界面
  仍需后续独立实现；当前行为是显式 `SE`，避免误判。
