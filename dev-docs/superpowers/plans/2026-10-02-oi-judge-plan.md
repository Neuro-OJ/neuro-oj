# Neuro OJ 传统 OI 评测实施计划

Status: approved

## Global Constraints

- 用户已批准实施；直接执行，不再走 brainstorming。
- C/C++ 非交互题；标准/文件输入输出、SPJ、子任务；原生和 WASM 后端按题目固定，禁止静默回退。
- 默认语言 c=C99、cc=C++11，-O2 -Wall；默认原生后端。WASM 使用 WASI SDK，支持 bits/stdc++.h 标准库兼容头。
- 子任务全部通过且依赖满足得满分，否则零；无子任务的按点计分转换成单点子任务。
- 用户资源默认每点 1000ms/256MiB，最大512MiB，最多100点，时限之和最多60秒；编译10秒/512MiB；输出32MiB；单提交测试点并发2；整任务墙钟300秒。
- 原生 CPU 时间计量、三倍墙钟保护；WASM floor(time_limit_ms * fuel_per_ms)预算，等效耗时与真实CPU/墙钟分别报告；外层超时、宿主资源不足判SE。
- 子任务内固定顺序，失败后余点IGN；独立子任务可并发；跨worker共享配额走Redis，禁止新增进程级可变共享状态。
- default/strict/testlib checker；默认答案比较对齐本地 ../HydroOJ；SPJ只有满分算通过；常见OI判定AC/WA/TLE/MLE/OLE/RE/CE/SE/FE/IGN。
- 不增加题目历史版本管理；重测使用当前题包/配置/活动成本表，沿用rejudge_seq。单任务使用一致的数据快照。
- 硬件拟合生成全站固定成本表：非负正则化回归，整数化，可信基准，独立留出验证；P95相对误差<=25%，各类别中位误差<=20%；比赛期间冻结。
- DB迁移必须deno task db:generate生成，不手改journal或锁文件；所有注释/文档中文；非平凡变更须Agent Note。
- Deno测试必须deno task，core按domain规定命令；Rust cargo nextest run --all-targets；全程保留已有AI题行为与比赛权限。

## Architecture

新增OI编排分支，复用现有Redis队列、用户claim、支持包校验和结果回传。编译/原生/SPJ使用专用评测主机上的go-judge服务，WASM使用外层沙箱内的独立Rust Wasmtime runner；题目只保留当前数据。题目配置新增judge_type=dual|oi，存量dual；OIDetails结构与生命周期status分离。

## Task 1: Core契约、题包与提交接入

- 负责noj-core、共享NOJ/Hydro OI契约夹具；不修改Rust/UI/CLI源码。
- 先写失败测试，覆盖OI配置验证、资源继承、子任务依赖和分值、路径穿越、双容器兼容、构造任务、自测/重测/结果投影。
- 新增judge_type=dual|oi列(默认dual)并通过db:generate生成迁移。
- 推荐不破坏现有RuntimeConfig双容器类型：新增独立OiRuntimeConfig，业务输入/DB配置联合；MQ保留既有runtime_config(dual可选)，OI携带独立oi_config字段，由judge_type区分。公开API能清楚表达配置。
- OI配置包括backend、time_limit_ms、memory_limit_mb、languages、filename可选、checker(default/strict/testlib和源码路径)、subtasks(稳定id、score、依赖、cases输入/答案路径、可选资源覆盖)、compile/user extra files、WASM成本配置(任务注入，用户不可指定)。语言c/cc仅允许OI，原AI语言验证保持原有约束。
- 扩展NOJ manifest/zip解析，不要求OI evaluate.py；从config.yaml/config.yml读取配置并规范化。支持Hydro非交互题目ZIP，检测problem.yaml、题面及testdata/config.yaml；不支持的题型/计分必须拒绝，sum按点转换可保持分数。
- default/strict/testlib浮点checker、缺失文件、重复id、依赖环、无效分值与资源边界都在导入时校验。
- 扩展buildJudgeTask唯一入口和所有CRUD、自测、重测、sweeper路径，OI任务携带一致配置/题包URL，判定存details.oi并公开只读verdict。
- 保留pending/judging/finished/error和×100分值；OI的AC判断与部分分要同步统计/排名/标签可见性，不能把有分数等同AC。
- OI结果投影保留允许公开的元数据，禁止隐藏输入/答案/用户输出/checker诊断经REST/SSE泄露。
- 活动WASM成本表由system域提供，在构造任务时注入(若Task3尚未提供，留明确调用接缝，但禁止缺省虚假成本或静默回退)。
- 运行catalog/submission/contest规定domain测试以及core check；记录RED/GREEN和未解决集成点。

## Task 2: Rust OI沙箱、原生与WASM执行

- 负责noj-judge、Rust契约测试、OI运行镜像/辅助构建脚本；接口以Task1输出oi_config/judge_type为准。
- 先测契约、比较器、计分、状态映射、资源边界、依赖和确定性，再实现src/oi独立模块及main/runner分派。
- 实现认证的go-judge HTTP客户端，编译用户源码与testlib checker、文件缓存/清理、原生测试点运行、CPU与峰值内存、文件IO、输出限额。
- 服务地址/凭据来自受控worker配置，禁止用户提供命令、URL、编译参数或宿主源路径；沙箱仅获得必要文件。
- 新增Wasmtime runner独立可执行目标；明确guest stdin/stdout与可信统计输出隔离，不让程序伪造结果；运行时成本表摘要参与编译缓存。
- 正式计量覆盖批量内存与宿主I/O；确定性时钟/随机源，禁网络/线程等接口；限制线性内存/运行栈/表/缓冲；资源不足不启动或SE。
- 用户WASM预算耗尽TLE，超过用户内存MLE，非法guest访问RE；引擎错误/外层限制SE；native沿用CPU时间/三倍墙钟。
- 独立子任务并发2且组内顺序；按依赖拓扑执行；失败余点IGN，跳过点不参与总状态/资源统计。任务取消、异常、超时全路径清理。
- go-judge节点共享CPU/内存配额用Redis租约；本地仅任务局部状态，不能新增进程配置缓存或全局计数器。
- 实现WASM校准所需可信基准执行/动态计数接口(供Task3使用)，计数与计时分开，真实计量开启后的模型须验证。
- 增加native+WASM集成测试，按NOJ_RUN_E2E守卫；真实沙箱不可用时明确报告，提供可复用启动脚本而不伪造通过。
- cargo fmt/clippy/nextest；使用Cargo正常生成锁文件，禁止手改。

## Task 3: CLI校准与system成本配置

- 负责noj-cli及noj-core system/admin校准服务和路由(不改Task1目录，必要跨域接口先沟通)。
- 新增noj-cli judge calibrate，在指定真实评测硬件运行Task2基准接口，产出成本表JSON与报告。
- 实现非负正则化回归；微基准+真实算法；独立算法/规模留出；整数化后验证；成本下限及默认未覆盖操作；禁止伪造执行数据或把默认表说成拟合结果。
- 通过P95<=25%及类别中位<=20%和计量安全验证才允许启用。报告绑定工具链、runtime、benchmark和成本表摘要。
- system DB保存活动成本表；管理员导入/查询/启用，沿用system:settings和审计，活动WASM比赛期间禁止切换。遵守现有设置失效“重新加载”机制；OI任务注入完整表与hash。
- CLI题包init/pack/lint同步Task1契约(vendor按既有同步脚本)，C/C++模板，支持Hydro导入校验。
- 增加沙箱连接/工具链/资源校验、部署env与CLI配置，专用go-judge不加入应用主机特权容器。
- 先测试拟合已知数据、约束、留出失败、错误报告与比赛冻结、CLI题包，再实现；deno task test/check与system domain测试。

## Task 4: UI端到端OI体验

- 负责noj-ui；Task1/3 API已确定后实施。
- OI题目创建/编辑、后端/时空/checker/子任务配置；选择c/cc与Monaco语言；支持OI题包上传/导入。
- 题面展示传统时间/内存，WASM说明等效计量；提交详情独立verdict、子任务、测试点、资源/编译错误，保留AI题显示。
- 管理后台导入校准JSON、查看误差/覆盖和活动配置，合格配置可启用并展示赛期冻结错误。
- 严格使用useApi与品牌tokens，权限依现有系统；不要展示隐藏输入/答案/诊断。
- 写真实格式/组件行为测试并跑deno task test/test:components/check/build。

## Task 5: 集成验收、文档和发布接入

- 负责noj-tests、noj-docs、dev-docs、CI/部署文档和最终跨模块修复(按发现问题原任务实施者处理)。
- OI全链路导入/提交/自测/SSE/竞赛/重测/乱序覆盖/隐私测试；native和WASM真实沙箱测试。
- 加入相同硬件/题库/编译配置Hydro对比基准脚本，报告冷热缓存吞吐与P50/P95，不预设胜出，不伪造测量。
- 更新相关模块开发文档、出题/运维指南、环境变量示例与CI路径触发、构建配置、Agent Note。
- 全量相关检查：core domains/system/catalog/submission/contest，共享测试，UI/CLI任务，Rust fmt/clippy/nextest，跨域E2E，迁移安全/文档/Agent Note/契约。
- 最终代码评审；保留可审查工作副本，不未经要求推送/合并/发布。

## 接口裁定记录

用户批准了能力和行为，具体字段命名与内部拆分由实施者按现有架构落实。Task1确定wire契约后其余任务遵循同一份fixture；类型扩展不得静默改变存量dual任务。所有偏离必须写入实施记录并说明原因及影响。
