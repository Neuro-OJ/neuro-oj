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
- native OI runner 使用 Worker 固定的 `JUDGE_OI_IMAGE`；生产环境配置
  `JUDGE_GO_JUDGE_URL` 后由专用 go-judge 节点编译/运行，开发和离线环境保留一次性非
  root、`network_mode=none` 的 Docker 兼容路径。语言固定为 C99/C++11，原生 CPU 限制
  和三倍墙钟保护分别记录；输出上限为 32 MiB。
- OI 细分状态使用 `AC/WA/TLE/MLE/OLE/RE/CE/SE/FE/IGN`，仍封装为现有
  `JudgeResult`，由 core 侧白名单归一。
- WASM 使用 Worker 固定的 WASI 编译器和 Wasmtime fuel；活动成本表通过 system settings
  注入，执行器同时保留 fuel 等效耗时、执行线程 CPU 时间和墙钟时间。testlib checker 在 native
  路径使用独立 checker sandbox，WASM 路径使用只读预打开目录运行独立 checker module，
  不回退为宿主执行或把题包中的 checker 当作平台代码执行。
- 题包声明的 compile/user/checker extra files 经过路径与测试数据保护校验后分别注入
  编译与运行沙箱；Hydro `judge_extra_files` 只进入 checker sandbox，避免把 checker
  辅助代码泄露给选手。用户编译失败归因 CE，checker 编译或宿主执行异常归因 SE，依赖
  子任务继续由 scorer 归因 IGN。
- Hydro 未声明子任务分值时，导入器按百分之一的最大余数法稳定分配 100 分，避免三等分
  等常见配置因浮点舍入被错误拒绝。
- go-judge 原生节点一次编译提交并用 fileId 复用用户程序和 testlib checker；就绪的独立
  子任务最多并发 2 个，子任务内部保持测试点顺序，首个失败后的余点由 scorer 归因 IGN。
- 校准模块提供可审计的非负正则化线性拟合、整数化成本和独立留出验证；只有通过
  P95<=25%、类别中位误差<=20% 且真实计量已确认的报告才能启用。
- WASM 校准特征严格绑定 Wasmtime 49 的 `VariableOperatorCost` 字段，运行时完整映射
  16 个变量成本字段；等效 fuel 单位固定为校准模型单位（`fuel_per_ms=1`），避免报告
  验证了未被执行器使用的任意特征。
- CLI、管理 API 和 OI 创建页面共享同一份活动成本表契约；管理员切换成本表时检查比赛
  冻结窗口，读取路径不建立进程缓存。
- 用户与管理端题目编辑页按持久化 `judge_type` 选择 OI 编辑器；编辑已有题目时保留未在
  表单展开的文件输入、额外文件和测试点资源覆盖字段，避免普通题面修改破坏评测契约。
- `noj-cli problem init/lint/pack` 与 core 题包契约同步：`--judge-type oi` 生成含
  `testdata` 的 C/C++ 骨架，离线 lint 校验 OI 测试点、checker 和 extra 文件引用，
  不再把缺少 `evaluate.py` 错误地判为 OI 题包无效。
- 客观题套卷切换会同时清空旧的 OI/双容器运行配置并把 `judge_type` 归一为 `dual`；
  这样导入/编辑后的题目不会残留可执行评测配置。

## Alternatives considered

- 把 OI 题转换成双容器 `evaluate.py`：会重新引入墙钟/脚本协议，无法保证 C/C++ 编译和
  常见 OI 状态码的一致性，因此未采用。
- 在 judge 宿主机直接执行编译器或 checker：安全边界不可接受，因此未采用。
- 让题目消息携带 OI 镜像：会绕过 Worker 的可信镜像配置，因此固定为 `JUDGE_OI_IMAGE`。

## Consequences

- 同一题目的重测读取当前数据库配置和最新支持包，不建立题目版本快照。
- native OI 题可以与 dual 任务共享 Redis 队列和并发调度；每测试点一次容器会增加容器
  创建/编译开销，后续可在不改变协议的前提下加入可信编译缓存。
- 生产 go-judge 路径已经复用编译产物并行执行独立子任务；没有配置专用节点时的开发
  Docker fallback 仍按测试点创建隔离容器，便于本地验证但吞吐较低。
- WASM testlib checker 需要节点的固定 WASI C++11 工具链支持 testlib 源码；编译或
  checker 运行失败均明确归因 `SE`，不会把 checker 编译到用户代码的同一沙箱中。
- go-judge 原生路径使用 `copyOut` 读取文本输出，避免把 `copyOutCached` 返回的 fileId
  当作选手输出；Hydro 的额外文件同时保留题包路径并按 basename 注入编译/运行工作目录。
- go-judge 响应缺少退出状态或文件题缺少输出文件时按系统/格式错误处理，不把不完整响应
  当作通过。
- 远端 go-judge 子任务通过 Redis 有序集合租约共享跨 Worker 的并发槽位，租约使用 Redis
  服务端时间并由 TTL 回收；本地 Docker 回退路径在编译后删除仅编译可见的 extra 文件，
  与远端/WASM 的文件范围保持一致。
- WASM 后端也按 DAG 批次并发最多两个独立子任务，单个子任务仍顺序执行测试点，并把
  每个测试点放到独立 `spawn_blocking`/临时目录中，避免并发任务共享 guest 文件状态。
- WASM guest 使用可取消的异步 WASI 调用、epoch 中断和三倍等效时限墙钟；文件输入题
  由监控线程与结束后复核共同限制运行期间新增工作目录数据为 32 MiB。WASI 编译器使用
  独立进程组、512 MiB 地址空间、10 秒 CPU/墙钟和 64 MiB 编译输出上限，超时会回收整组
  子进程，避免 `spawn_blocking` 取消后遗留编译器。
- Wasmtime 49 的 Rust 最低版本为 1.96，生产和 E2E judge 镜像的构建阶段同步使用
  Rust 1.96.1，避免本地检查通过而镜像构建失败。
