# Agent Note: 双容器评测隔离/分片 RPC、产物分层保留与竞赛防作弊增强

Status: implemented

## Problem

在评估 Neuro OJ 评测引擎与竞赛运营能力时，存在以下几处短板：

1. **选手 `print()` 调试体验与盲测防泄题矛盾**：Solution host 直接共用 fd 1 承载 NDJSON 协议帧，导致用户 `print()` 被丢弃或污染协议，同时前端缺乏可见用例标准输出展示。
2. **跨测试点全局状态污染与超时难以强杀**：Solution 容器在单次评测内常驻执行多个测试点，前序用例修改模块全局状态或死循环会干扰后续用例并无法单独中断。
3. **双容器冷启动串行耗时与 1 MiB 单帧软上限**：Evaluator 与 Solution 的容器创建、文件注入与 `start_exec` 全程串行；单帧 1 MiB 限制阻塞了大图像、嵌入向量或批量样本的跨容器传参/返回。
4. **产物提交包缺乏分层保留策略**：`submissions.artifact_storage_url` 长期留存无自动/受控清理机制，导致非最佳产物持续消耗对象存储与域配额，且文档与代码现状不一致。
5. **竞赛静默粒度偏粗与反作弊相似度上限不足**：社区静默在竞赛 `pending` 筹备期即全站生效；代码相似度检测基于 O(n²) 双重循环并硬上限 200 份，且全局变量重编号对前置插入变量敏感，缺少预测向量与产物 ZIP 源码相似度辅助能力。

## Decision

在不引入任何数据库 schema 迁移的前提下，分三阶段实施以下改动：

1. **Solution 日志协议隔离（P0-1）**：`noj_solution_sdk/host.py` 通过 `os.dup(1)` + `/dev/null` 隔离协议输出 fd，拦截 `sys.stdout` 封装为带 `call_id`、单帧 64 KiB / 累计 1 MiB 配额的 `log` 帧；`noj-judge` 二次限流；`noj_evaluator_sdk/runner.py` 默认关闭 stderr 透传并按 `call_id` 有界捕获（8 KiB）；`noj-core` 白名单保留非隐藏用例 `stdout`/`stderr`（4 KiB）并在非管理员投影路径严格剥离隐藏用例流；`noj-ui` 在提交详情页展示可见用例标准输出。
2. **竞赛社区静默分级（P0-3）**：将社区静默窗口收窄至 `running` 阶段；在 `contests.config` 中引入 `community_silence_mode`（`domain_all` / `contest_participants` / `none`），社区路由与服务透传 `actorId`，并在竞赛创建/编辑表单暴露该配置。
3. **按调用 fork 隔离与超时强杀（P1-1）**：在 `runtime_config.solution` 新增可选 `isolation_mode`（`shared` | `fork_per_call`）；`noj-judge` 调用超时时向 Solution 写入 `cancel` 帧；`host.py` 在 `fork_per_call` 模式下以 `os.fork()` COW 子进程执行单次调用，通过独立进程组 `SIGKILL` 强杀超时子进程，并经同步管道保持 `call_capability` 可用。
4. **反作弊相似度扩容与抗变形（P1-2）**：`contest-similarity` 改为倒排索引候选配对（默认上限提升至 `1000`）并支持可选高频指纹 DF 过滤；新增 `normalizeCodeBlocks` 块级局部归一化融合评分；补充预测向量共同错误重合度（`prediction.ts`）与产物 ZIP `.py` 源码提取（`artifact-source.ts`）。
5. **并行冷启动与透明分片 RPC（P2-1）**：`DualContainer::create_pair` 与 `orchestrator.rs` 并行执行双容器创建（单侧失败立即销毁成功方防孤儿）、文件注入与 `start_exec`，记录 `startup_ms`（销毁保持先 Solution 后 Evaluator）；`noj_sdk_common/chunking.py` 与 `noj-judge` 实现 `type: "chunk"` 透明分片，保持单物理行 `<= 1 MiB`，默认支持最高 `16 MiB`（可配至 `32 MiB`）大载荷传输，并在宿主侧施加 `64 MiB` 累计配额且跳过 `stdout_full` 记录。
6. **产物分层保留与受控回收（P2-2）**：新增 `artifact-retention.ts` 纯策略判定与受管清理任务（默认 `ARTIFACT_RETENTION_ENABLED=false` 安全 opt-in），按 Tier 0（在途/进行中竞赛及赛后 7 天宽限期永久保护）、Tier 1（通过/竞赛有效产物默认永久保留）、Tier 2（非最佳产物默认 14 天）仅解绑 `submissions.artifact_storage_url` 并走引用守卫 `deleteStorageObject()` 释放对象与域配额；重测缺失产物返回稳定 `ARTIFACT_MISSING`；提供默认 `--dry-run` 的 `deno task storage:retention` CLI，并同步全部相关文档。

## Alternatives considered

- **使用共享只读/临时卷替代分片 RPC 传递大载荷**：会改变双容器无共享挂载的安全边界并增加宿主机临时目录清理复杂度；协议层透明分片保持纯管道边界、对用户代码零侵入，且继续复用现有 `InFlightTracker` 超时与配额体系。
- **使用常驻暖容器池消除冷启动**：暖容器池引入跨提交状态残留、cgroup/tmpfs 重置与镜像版本切换风险；先通过双容器创建/注入/启动全链路并行化即可无风险削减近半冷启动墙钟时间，同时保持“一次提交一对全新容器”的安全基线。
- **通过新增数据库列存储静默模式与产物过期时间**：需编写并协调迁移脚本；复用 `contests.config` JSONB 与 bootstrap 环境变量即可满足需求并保持零迁移成本。
- **默认开启产物自动清理或直接清理未引用孤儿对象**：违背 `object-storage-governance.md` 的零隐式破坏原则；改为默认关闭 opt-in、仅解绑 `submissions.artifact_storage_url` 并经引用守卫删除更安全。

## Consequences

- **正向收益**：选手可在双容器题中正常使用 `print()` 调试可见用例而不泄题；题目可按需开启 `fork_per_call` 杜绝状态污染并强杀死循环；AI/多模态题可透明传输最大 16 MiB 参数/返回值且冷启动延迟降低；大规模竞赛相似度检测扩展至 1000 份并提升抗改写召回；运维可通过 `storage:retention` 预演并按需回收非最佳历史产物释放存储与域配额。
- **兼容性与约束**：所有新增协议帧（`log`、`cancel`、`chunk`）与配置项（`isolation_mode`、`community_silence_mode`、`ARTIFACT_RETENTION_*`）均向后兼容；`capability` 返回值仍维持默认 1 MiB 软上限以防止反向大对象冲击 Evaluator。
- **后续运维/验证**：`noj-core` 依赖 PG/Redis 的集成测试与 `noj-judge` Docker E2E 需在 CI 完整环境中运行验证。
