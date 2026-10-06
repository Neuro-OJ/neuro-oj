# Judge 资源池调度协议

调度协议版本为 `1`。Core 从运行配置推导 `oi-wasm`、`oi-native` 或 `ai`，Worker
校验 `resource_pool` 和 `scheduling_version`；不匹配返回
SE，提示重测。此协议不改变评分协议、题目资源限制或 `noj-wasm-v3` 的 fuel 规则。

## 启动配置

| 参数                             | 默认值                 | 作用                                   |
| -------------------------------- | ---------------------- | -------------------------------------- |
| `JUDGE_RESOURCE_GROUP`           | 实例标识               | 共享硬件上的 Worker 必须填写相同组名   |
| `JUDGE_RESOURCE_POOLS`           | `oi-wasm,oi-native,ai` | 可仅启用部分池                         |
| `JUDGE_WASM_TASK_CONCURRENCY`    | 4                      | WASM 活跃提交容量                      |
| `JUDGE_NATIVE_TASK_CONCURRENCY`  | 2                      | Native 活跃提交容量                    |
| `JUDGE_AI_TASK_CONCURRENCY`      | 2                      | AI 活跃提交容量                        |
| `JUDGE_WASM_COMPILE_CONCURRENCY` | 2                      | 源码、checker 与 Module 编译容量       |
| `JUDGE_WASM_CASE_CONCURRENCY`    | 16                     | 全组共享的 WASM 测试点运行容量         |
| `JUDGE_RESOURCE_MEMORY_MB`       | `auto`                 | 有效物理/cgroup 上限的 50%，或显式 MiB |

容量在启动时冻结，整数范围为 1–1024。同组 Worker
的全部容量和内存预算必须一致，即使启用的池不同；不一致时启动失败。容器中的
`auto` 会受容器 cgroup 限制，混合宿主与容器 Worker 时应显式指定共同预算。各
Worker 仍须有独立实例标识，否则用户 claim 清理及观测心跳会互相覆盖。

`JUDGE_MAX_CONCURRENT_JUDGES`
已弃用，不再约束新池；启动日志给出替代提示。每池分别允许同一用户占用一次正式提交和一次自测批次。

修改同组容量时，先暂停入队、排空并停止所有组内 Worker，等待心跳和租约结束，再用
`cargo run --release --example resource_group_reset -- <claim-prefix> <resource-group>`
解除配置锁。该工具需要显式 `REDIS_URL`，有效心跳或租约尚存时拒绝操作，不会停止
Worker。默认队列的 claim-prefix 为 `noj:judge`。之后以一致配置启动全部 Worker。

## 队列和恢复

三级队列为 `{prefix}:{pool}:{high|medium|low}`。每池按 4:2:1
轮转，同优先级三个池共同使用原来的待评测总容量。processing、重投、死信保留来源队列。

Core 默认使用池布局。`JUDGE_QUEUE_LAYOUT=legacy`
只用于协调升级前的临时兼容运行；Redis 布局标记已切换为 pools 后，兼容 Producer
拒绝继续入队。旧二进制不认识这个保护，因此升级前必须暂停所有入队并停止旧消费者。

启动迁移使用 Redis 分布式锁，要求旧 processing
排空；逐条原子搬运旧任务，保留身份、源码、优先级和评测轮次，仅补充调度字段。非法配置进入来源死信。迁移可重复执行，不触发历史重测。应先确认所有新
Worker 的协议和 WASM 标准一致，再恢复入队。当前本地 Judge 的启停由用户控制。

## 准入和执行

任务、编译、测试点槽位与内存由 Redis Lua 原子准入。租约每 10 秒续租，有效期 60
秒，使用 Redis
服务端时间。续租失败停止新执行并取消已有执行。执行线程持有租约直至退出，异步
future 取消不会提前释放容量。

任务预留数据和 Engine/Module
基础内存及至少一个阶段的余量。阶段先使用该余量，超过的部分才额外计入共享预算，避免多个任务持有数据后互相等待编译内存。测试点预留
guest 声明内存和 128 MiB 输出/宿主余量；源码编译预留 512 MiB。解压前按现有 512
MiB 上限及副本余量预留，加载后调整为实际数据大小。超过整组预算的最低需求明确返回
SE，不无限等待。

内存预算是调度估算，仍需操作系统/cgroup 内存限制。Worker RSS
超预算时停止新准入；这个观测不等于容器、编译子进程和整个宿主的完整内存峰值。

SUM 用例可并行；MIN/MAX
内部保持顺序与短路；已满足依赖的独立子任务同时推进。全组运行槽位按准备好的提交轮转分配，不抢占正在运行的用例。取得槽位后才发布开始事件，结果按配置顺序归档。

同次提交共享固定配置的 Engine，用户及 checker 分别编译一次 Module。每点有独立
Store、WASI、内存、目录和输出。Engine epoch 驱动共享，但各 Store
独立检查墙钟、取消与输出保护，不把某点超时传播到其他点。不增加跨提交的 Module
缓存。正式评测和自测共享运行容量。

## 离线验收

`noj-judge/examples/oi_pool_benchmark.rs` 不需要数据库，不消费
MQ，不写正式成绩。显式配置专用测试 Redis 和通过标准校验的 SDK 后运行：

```sh
cargo run --release --example oi_pool_benchmark -- source.cpp runtime.json data-directory 16
```

数据目录按配置文件名提供输入和答案。当前入口针对普通比较器，不支持通过省略
checker 源码来验收 testlib 题目。报告记录完整评测墙钟、运行准入等待
P50/P95、进程峰值 RSS、源码/标准摘要以及逐点计量；正式数据留在仓库外。对照
1、2、4、8、16
槽位应比较输出、状态、fuel、模块与计量摘要，不能要求墙钟一致。第一次新进程运行不代表操作系统文件缓存已清空。

队列页面展示按池待评测、processing、活跃任务、编译/运行槽位及预留内存。心跳按资源组去重，防止同组多个
Worker 重复计算共享容量。
