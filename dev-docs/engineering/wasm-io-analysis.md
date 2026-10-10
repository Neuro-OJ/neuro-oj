# WASM IO 分类分析工具

`wasm-analyze` 是独立开发者工具，不消费 Redis、不访问数据库、不改正式成绩。
它分别执行原始 v2 模块和插桩模块。`noj-wasm-v1`、`noj-wasm-v2` 的清单、成本、
换算尺度和正式编译参数保持不变。本工具不发布 v3、不提供 IO 豁免。

## 使用

先按现有工具链入口构建固定 v2 SDK，显式指定编译器和 sysroot。资源配置文件使用
现有 `OiRuntimeConfig` JSON；支持包使用现有题包 ZIP，引用路径必须匹配。

```bash
export JUDGE_WASI_CC=/opt/wasi-sdk/bin/clang
export JUDGE_WASI_CXX=/opt/wasi-sdk/bin/clang++
export JUDGE_WASI_SYSROOT=/opt/wasi-sdk/share/wasi-sysroot
bash scripts/wasm-analyze.sh \
  --source /tmp/main.cpp --language cc \
  --config /tmp/runtime-config.json --package /tmp/problem.zip \
  --output /tmp/report.json --artifacts /tmp/analysis-artifacts \
  --repeat 2
```

`--case testdata/1.in` 只分析指定点；默认分析所有声明的点，包括正式子任务失败后
会被跳过的点。`--repeat` 为 1–10，默认 2；单次运行的重复验证字段为
null。产物目录必须不存在。编译失败返回
错误和编译诊断，不制造一份完成的分析报告。

`--native-image noj-oi-cpp:latest` 增加同机原生 CPU
对照。镜像必须已经存在，且提供 GCC/G++ 和 Python
3；不会拉取镜像。对照执行现有题目时限和额外 2000ms CPU 时限，
每种时限重复指定次数，记录编译器、镜像 ID、CPU 时间和输出摘要。运行使用无网络、
只读根文件系统、cap-drop、独立临时目录、进程/CPU/内存/输出保护。
原生对照目前只支持 default/strict checker；WASM 分析支持 testlib 及额外文件。

JSON 和同名 Markdown 测试点表格保存在 `--output`。产物目录保存原模块、分析链接
模块、插桩模块、选手目标文件、规范化链接映射和函数来源清单；不复制测试输入输出。
报告记录源码、标准、工具链、评测配置/引用数据、模块及来源映射摘要。产物可能包含
选手代码和调试符号，应按本地开发产物管理，不提交正式题目数据。

## 来源与计数

SDK 在编译前进行完整内容校验。仅受控链接器映射中实际选中的 SDK 对象和归档成员
能获得 SDK 来源。函数名仅在来源确认后用于 IO 候选分类。选手目标文件中的函数、
头文件模板和内联代码都计入选手成本。弱符号/别名以最终函数体归属为准；归档含
同名成员、映射无法唯一确认或链接器生成辅助函数时，保守标为来源未确认。

分析编译关闭 LTO，保存 `main.o`，保留 `-O2` 和普通内联。lld 的 CODE 偏移在最终
长度编码收缩前记录，因此必须验证全体函数数量、相对偏移和尺寸一致后才应用统一
偏移修正。缺少证明时不能仅按符号名认领来源。

新增计数 globals 追加在原索引空间末尾。原模块先校验，不能通过原 global 索引
访问新增计数器；导入/导出中的 `__noj_analysis_` 名称冲突会被拒绝。重编码保持原
函数、类型、全局、表、元素和数据索引，新增局部变量用于保留批量操作的长度。

每个最终函数体独立统计原指令成本，使用 v2 的固定表。已内联的并查集、排序或解析
代码计入实际容纳它们的函数，不能声称已经按源函数拆开成本。纯指令段在控制边界结算，调用、
控制转移和可能陷阱的操作在尝试前结算。批量内存、内存增长和表操作另计长度成本。
插入的指令不进入分类计数；模块实例化/宿主工作不归入函数成本。该统计规则独立于
Wasmtime 的 fuel 分块/预收行为，不要求分类总量与原 fuel 相等。

报告分为选手、可信 IO 候选、其他 SDK、来源未确认四类。每个函数的动态调用都按
自身来源统计，自定义 streambuf、locale、运算符等回调不能继承 SDK 调用者身份。
`num_get` 等共享函数同时服务文件流和字符串流，因此 **IO 候选不等于可豁免 IO**。
本阶段不根据调用者名字推断外部 IO 上下文。

## 保护与解释

原始运行使用原 v2 fuel 预算。插桩运行使用其 50 倍作为 raw fuel 保护，两者都沿用
`max(30000ms, 题目时限 × 10)` 墙钟保护及 WASI 文件、内存、输出限制。
原始结果单独记录；分析超限/陷阱标为 `analysis_incomplete`，其计数是部分统计，
不生成正式 TLE，也不估算完整程序成本。

完成的分析另记录 `analysis_output_verdict`，只用于说明额外运行的输出。只有两次
运行都完成时才比较输出摘要；没有可比较运行时 `completed_outputs_match` 为 null，
不能把它当成“输出一致”。固定基准要求原始输出及插桩输出一致。

`hypothetical_without_io_candidate_ms`
只是去掉候选分类后的工作量换算，不是成绩， 不保证可准确隔离 IO，不等于 CPU
毫秒。尤其不能用去除 IO 后的估算强行复现某站的
得分：不同预算、标准库、编译器和硬件都可能造成差异。

## 验收

普通 nextest 覆盖分支、间接调用、索引保持、陷阱、无限循环及变量成本。
`noj-judge/scripts/check-oi-wasi-toolchain.sh`
还运行固定生成数据的来源验收，验证用户 弱符号覆盖、模板/内联、流回调、locale
和字符串流，比较两个独立进程与
`fixtures/noj-wasm-io-analysis-v1.json`。该快照独立于已发布 v2 基准。

正式 club、road 数据仅在本地验证。后续 v3 必须另行解决共享解析的外部 IO 上下文、
标准化 IO 费率、资源保护和正/反解区分；本工具的候选标签不能直接用于豁免计费。

## v3 换算更新

分析工具当前跟随内置 `noj-wasm-v3`，预算、checker 预算、参考时间及假设非 IO
时间均读取标准的 20,000,000 fuel/ms，不使用写死的 v2
尺度。分类规则和全部算子成本保持不变；历史 v2 分析报告不改写。
