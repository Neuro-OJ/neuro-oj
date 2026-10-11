# PR #622 题目版本管理审查问题跟踪清单

> **审查基准**：PR #622 提交 [`061ff7d0`](https://github.com/Neuro-OJ/neuro-oj/commit/061ff7d05)  
> **对照文档**：[Handbook](/home/xyber-nova/Github/neuro-oj/dev-docs/problem-version-management-handbook.md)  
> **审查结论**：**目前不建议合并 PR #622**。实现搭出了版本、尝试和有效成绩投影的主体，但评测配置来源、存储留存、事务一致性、批任务恢复、客观题统计等关键路径没有闭环，“功能全部落地”的结论不成立。  
> **说明**：本清单用于跟踪发现的 56 项缺陷与并发风险，区分已确认的实现缺陷与并发时序风险，待后续统筹修复与验收。

---

## 进度概览

> **2026-10-10 修复轮次**：本清单 56 项已按「修复 / 带证据核实为无需改动」两种方式全部处置，
> 逐条结论见文末[「修复轮次执行记录」](#修复轮次执行记录2026-10-10)。下表 `完成度` 按该记录填写。

| 模块 / 领域 | P1（阻断） | P2（次要/健壮性） | 合计 | 完成度 |
|---|---|---|---|---|
| 一、版本绑定与实际作答、评测内容 | 7 | 2 | 9 | 9 / 9 |
| 二、对象存储与删除 | 5 | 1 | 6 | 6 / 6 |
| 三、草稿、发布与导入 | 3 | 5 | 8 | 8 / 8 |
| 四、存量迁移 | 2 | 0 | 2 | 2 / 2 |
| 五、尝试、结果协议与有效投影 | 5 | 0 | 5 | 5 / 5 |
| 六、批任务 | 6 | 5 | 11 | 11 / 11 |
| 七、用户升级 | 2 | 0 | 2 | 2 / 2 |
| 八、竞赛策略、榜单和结算 | 4 | 0 | 4 | 4 / 4 |
| 九、缓存与全部成绩读取 | 3 | 2 | 5 | 5 / 5 |
| 十、客户端与 CI | 0 | 4 | 4 | 4 / 4 |
| **总计** | **37** | **19** | **56** | **56 / 56** |

---

## 一、版本绑定与实际作答、评测内容

- [ ] **1. [P1] 初次提交记录的是指定版本，实际执行的却可能是最新版**
  - **位置**：[submissions-crud.ts:482](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/submission/services/submissions/submissions-crud.ts#L482)、[artifact-submissions.ts:248](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/submission/services/submissions/artifact-submissions.ts#L248)
  - **现象/风险**：解析版本后，支持包、`runtime_config`、LLM 配置仍取 `problems` 当前投影。用户提交 V1、最新版为 V2 时，会留下“版本标记 V1、实际按 V2 判卷”的错误成绩；产物大小限制也可能采用 V2。
  - **修复建议**：从同一个已解析版本及其 `problem_version_objects` 构造完整执行上下文，后续禁止再取题目内容投影。用 V1/V2 不同 checker、语言、LLM 配置和产物限制分别回归。

- [ ] **2. [P1] 默认题目详情与竞赛题面会返回版本号和内容不一致的响应**
  - **位置**：[problems.ts:291](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/catalog/routes/problems.ts#L291)、[contests.ts:956](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/contest/services/contests.ts#L956)
  - **现象/风险**：普通详情只有显式传入 `version_id` 才覆盖内容，因此 `exact(V1)` 默认读取仍可能显示 V2。竞赛查询只从版本表取版本号，题面和运行配置仍取 `problems`。
  - **修复建议**：默认、显式历史版本、竞赛固定版本统一经过版本内容 DTO；支持语言、后端等派生字段也由该版本计算。验证“最新版 V2、题库 exact V1、竞赛固定 V1”三个入口内容一致。

- [ ] **3. [P1] 客观题展示的小题没有绑定作答版本**
  - **位置**：[objective-questions.ts:182](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/objective/services/objective-questions.ts#L182)
  - **现象/风险**：普通用户读取题库默认版本；竞赛参数仅参与权限校验，没有选择固定版本。编辑者则读取草稿。于是竞赛可能展示 V2 小题、按 V1 判卷；题目所有者作答时可能展示未发布草稿。
  - **修复建议**：编辑草稿与正式作答读取分开。正式小题接口接受明确版本，竞赛强制固定版本，前端同步传入并在换版后重新加载小题。覆盖所有者存在未发布草稿和两场竞赛固定不同版本的情景。

- [ ] **4. [P2] 模板下载始终选择最新版，历史作答和竞赛作答拿不到对应模板**
  - **位置**：[support-package.ts:536](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/catalog/services/support-package.ts#L536)
  - **现象/风险**：`resolveProblemTemplate()` 直接读取 `latest_version_id`；版本模板为空时还会回退本地源码，其内容也不属于历史快照。
  - **修复建议**：模板读取必须接受目标版本或竞赛上下文。已发布版本中的空模板应按该版本语义处理，不能从当前源码补内容。验证 V1/V2 模板不同以及 V1 明确为空的情况。

- [ ] **5. [P1] 历史版本接口绕过了运行配置的权限裁剪**
  - **位置**：[problems.ts:334](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/catalog/routes/problems.ts#L334)、[problems.ts:441](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/catalog/routes/problems.ts#L441)
  - **现象/风险**：显式历史详情直接返回 `runtime_config`；版本内容接口只裁剪客观题答案，对 AI/OI 内容原样返回。原题目响应隐藏的评测配置、内部命令或文件信息可能通过新接口公开。
  - **修复建议**：建立统一、按字段允许的公开版本响应，所有读取路径在内容合并后执行相同裁剪。测试匿名用户、普通用户和编辑者，并比较默认详情与历史详情的敏感字段集合。

- [ ] **6. [P2] 新提交仍存在静默补版本及 `legacy_unknown` 路径**
  - **位置**：[submission-version.ts:158](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/submission/services/versioning/submission-version.ts#L158)、[objective-submissions.ts:248](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/objective/services/objective-submissions.ts#L248)
  - **现象/风险**：竞赛缺少版本时自动采用固定版本；客观题缺少版本时自动采用默认版本；完全未发布题目还可解析为未知版本。最终迁移已经完成，这些“迁移期兼容”违反 Handbook §4.2。
  - **修复建议**：全部新提交和自测要求明确版本；未发布题目拒绝提交。未知版本仅供历史回填使用。覆盖代码、产物、客观题、自测的缺字段请求，确保不产生记录。

- [ ] **7. [P1，并发] 竞赛固定版本的检查与创建提交没有原子关系**
  - **位置**：[submission-version.ts:159](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/submission/services/versioning/submission-version.ts#L159)、[submissions-crud.ts:581](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/submission/services/submissions/submissions-crud.ts#L581)
  - **现象/风险**：固定版本在事务外读取，执行预检后才插入提交。期间管理员换版，旧版本提交仍可能被接受。
  - **修复建议**：提交落库事务锁定相应策略宿主，重新确认固定版本，变化时返回 `CONTEST_PROBLEM_VERSION_CHANGED`。用屏障控制“检查完成—管理员换版—提交落库”时序。

- [ ] **8. [P1] 自测混用所选版本运行配置与最新版支持包、样例**
  - **位置**：[self-tests.ts:150](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/submission/services/self-tests.ts#L150)、[self-tests.ts:223](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/submission/services/self-tests.ts#L223)
  - **现象/风险**：运行配置从版本解析，支持包及默认 OI 用例仍来自当前题目行。保存的快照也没有实际自定义用例、临时包引用和完整运行标识。
  - **修复建议**：支持包、默认样例均从所选版本读取；持久化实际用例、临时对象稳定引用及恢复配置。测试 V1 自测过程中发布 V2，以及带自定义用例的崩溃恢复。

- [ ] **9. [P1] Sweeper 没有按实际执行快照恢复，并明确丢弃 LLM 能力**
  - **位置**：[sweeper.ts:213](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/submission/mq/sweeper.ts#L213)、[sweeper.ts:381](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/submission/mq/sweeper.ts#L381)
  - **现象/风险**：恢复只读版本运行配置，支持包仍取当前投影；版本不存在时回退当前配置；恢复任务刻意不组装 `llm`。Provider、模型、预算、计时标准也未完整固定。
  - **修复建议**：尝试创建时保存完整非敏感执行快照，恢复只依赖该快照和稳定对象引用；仅重新生成交付凭据。Provider 不可用应报告平台错误，不能悄悄改为无 LLM 执行。

---

## 二、对象存储与删除

- [ ] **10. [P1] 产物在评测结束后仍被物理删除**
  - **位置**：[submissions-result.ts:253](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/submission/services/submissions/submissions-result.ts#L253)、[artifact-submissions.ts:427](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/submission/services/submissions/artifact-submissions.ts#L427)
  - **现象/风险**：完成或失败后直接删除产物；入队失败也删除，即使提交保留为可恢复 pending。升级共享同一对象时，评测其中一条还会破坏另一条。
  - **修复建议**：正式产物保留到提交显式删除；入队失败保留对象。回归“完成后重测”“完成后升级”“Redis 暂时断开后恢复”。

- [ ] **11. [P1] 上传失败补偿仍可删除其他记录共享的对象**
  - **位置**：[artifact-submissions.ts:269](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/submission/services/submissions/artifact-submissions.ts#L269)、[problem-bundle.ts:623](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/catalog/services/problems/problem-bundle.ts#L623)
  - **现象/风险**：多个错误分支直接调用 `storage.delete()`。内容寻址复用 URL 时，本次请求失败可能删掉已有提交或历史版本使用的文件。
  - **修复建议**：所有补偿、替换清理统一经过对象登记和引用守卫。测试两个请求上传相同字节，其中一个在校验或数据库阶段失败。

- [ ] **12. [P1，并发] 存储删除守卫实际没有形成互斥**
  - **位置**：[registry.ts:220](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/system/services/storage/registry.ts#L220)
  - **现象/风险**：登记行锁在第 233 行事务结束时释放，之后才检查引用并标记 `deleting`；绑定引用的检查也不加锁。可出现“检查无引用—新引用建立—对象删除”。
  - **修复建议**：检查全部引用与进入 `deleting` 必须在持有登记行锁的同一事务内；绑定也锁同一登记行并在该事务插入引用。真实 PostgreSQL 验证两个方向的竞争。

- [ ] **13. [P1] 存储查询异常被当成文件不存在，并永久写成 deleted**
  - **位置**：[registry.ts:261](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/system/services/storage/registry.ts#L261)
  - **现象/风险**：`stat()` 的所有异常被转换为 `exists:false`。S3 网络、认证或服务错误会使实际仍存在的对象被标记已删除。
  - **修复建议**：区分明确 NotFound 和临时/权限错误；只有确定不存在或物理删除成功才进入 deleted。注入超时、403、404 分别测试。

- [ ] **14. [P2] 对象状态机缺少删除崩溃恢复和重新上传恢复**
  - **位置**：[registry.ts:56](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/system/services/storage/registry.ts#L56)、[registry.ts:252](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/system/services/storage/registry.ts#L252)
  - **现象/风险**：进程在标记 deleting 后崩溃，后续删除不会继续；相同内容重新上传得到原 URL，登记 upsert 又不恢复 deleted 状态，因此新文件仍无法绑定。
  - **修复建议**：增加可恢复的删除租约或持久任务；成功重传后在互斥保护下恢复 ready，防止与旧删除任务竞争。验证崩溃重启及“删除后上传相同内容”。

- [ ] **15. [P1] 整题删除可能先破坏数据，再因版本外键失败**
  - **位置**：[problems-crud.ts:1043](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/catalog/services/problems/problems-crud.ts#L1043)、[submissions-crud.ts:943](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/submission/services/submissions/submissions-crud.ts#L943)
  - **现象/风险**：整题清理不是一个完整事务，且未先处理竞赛固定版本引用：提交、文件引用、最新版指针已经删除或清空，随后删版本会被竞赛外键拒绝。两种删除入口也没有拒绝活动尝试。
  - **修复建议**：固定锁顺序，锁内检查活动尝试；所有数据库清理原子提交，并按既有整题删除语义处理竞赛关联。对象清理在提交后走守卫，任务保留原始引用。测试竞赛关联题、活动评测和中途外键失败均无部分删除。

---

## 三、草稿、发布与导入

- [ ] **16. [P1] 新草稿接口绕过敏感字段权限及完整运行配置校验**
  - **位置**：[problems.ts:518](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/catalog/routes/problems.ts#L518)、[problem-content.ts:274](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/catalog/types/problem-content.ts#L274)
  - **现象/风险**：路由把客户端对象直接强转后保存；草稿服务主要校验 kind，AI 发布主要检查 evaluator/solution 存在，没有复用原编辑入口的敏感配置权限、运行参数和平台限制校验。
  - **修复建议**：共享服务端内容验证器；草稿允许不完整，但敏感字段权限和安全约束立即检查；发布执行完整配置校验。通过新接口直接构造非法配置和越权字段回归。

- [ ] **17. [P2] 客观题发布验证弱于小题编辑验证**
  - **位置**：[problem-content.ts:185](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/catalog/types/problem-content.ts#L185)
  - **现象/风险**：只检查 key、题型、题干和非空答案数组，没有完整检查选项、答案形式、答案引用、单选数量等。直接 PUT 草稿可绕过小题编辑器验证并发布无法正常判卷的小题。
  - **修复建议**：小题编辑、导入、整卷草稿、发布共用快照验证器。覆盖缺选项、答案引用不存在选项、single 多答案、judge 非布尔等情况。

- [ ] **18. [P1] 客观题包导入仍能修改已发布题型，并提前改公开投影**
  - **位置**：[problem-bundle.ts:511](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/catalog/services/problems/problem-bundle.ts#L511)
  - **现象/风险**：匹配已有题号后直接把题目行改成客观题，清空运行配置、模板和支持包，再另行写草稿。普通编辑入口增加的题型不可变检查没有覆盖这里。即使后来发布被拒绝，身份行已不一致。
  - **修复建议**：任何内容写入前检查已发布 kind/submission_mode；导入内容及文件只写草稿，公开内容投影只由发布更新。测试向已发布 AI/OI 题号导入客观题包，确认返回冲突且所有数据不变。

- [ ] **19. [P2] 旧内容更新入口由服务器补 revision，且冲突后可能已提交管理信息**
  - **位置**：[problems-crud.ts:878](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/catalog/services/problems/problems-crud.ts#L878)
  - **现象/风险**：身份、标签等先提交，草稿随后独立保存；草稿预期 revision 使用服务端刚读取的值，而非客户端编辑基线。旧页面更新不能可靠识别草稿冲突，后续失败也不能回滚先前写入。
  - **修复建议**：所有内容入口要求客户端草稿 revision；需要一起成功的管理信息和草稿改动放入同一事务。验证陈旧页面返回 409 后无任何部分变化。

- [ ] **20. [P1，并发] 文件引用修改不递增草稿 revision，发布预检可能失效**
  - **位置**：[support-package.ts:139](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/catalog/services/support-package.ts#L139)、[draft.ts:421](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/catalog/services/versioning/draft.ts#L421)、[publish.ts:350](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/catalog/services/versioning/publish.ts#L350)
  - **现象/风险**：上传、移除及替换引用存在不校验、不递增 revision 的路径；发布没有比较预检报告的 revision/文件集合与锁内状态。因此可检查 A 文件却发布 B 文件。
  - **修复建议**：内容与引用共用一个 revision，在同一事务更新；发布验证预检 revision 及内容、引用摘要一致。用并发替包/删文件测试，必须冲突而不能发布未预检对象。

- [ ] **21. [P2] “相同内容 unchanged”搜索全历史，导致恢复旧内容无法发布**
  - **位置**：[publish.ts:412](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/catalog/services/versioning/publish.ts#L412)
  - **现象/风险**：V1=A、V2=B 后把草稿改回 A，会返回 V1 和 unchanged，但最新版仍为 V2。用户收到成功响应，默认作答内容却没改变。
  - **修复建议**：unchanged 只与当前最新版比较；恢复历史内容应生成 V3。回归 A→B→A，确认最新版为 V3。

- [ ] **22. [P2] 文件 SHA 未知时仍允许用空串计算发布内容哈希**
  - **位置**：[problem-content.ts:144](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/catalog/types/problem-content.ts#L144)、[publish.ts:396](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/catalog/services/versioning/publish.ts#L396)
  - **现象/风险**：两个不同对象只要路径相同且登记哈希为空，就参与同一个内容哈希计算，可能误判 unchanged。存量支持包登记恰好允许未知 SHA。
  - **修复建议**：新发布版本必须取得文件实际 SHA；迁移基线允许未知，但发布前核实并补齐。测试不同字节、相同逻辑路径、初始未知 SHA 的对象。

- [ ] **23. [P2] 发布审计与搜索通知不是事务中的持久化事件**
  - **位置**：[publish.ts:509](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/catalog/services/versioning/publish.ts#L509)
  - **现象/风险**：版本提交后才写审计和搜索事件。进程崩溃或 Redis 故障会留下已发布版本但永久缺少审计或索引更新。
  - **修复建议**：审计及持久 outbox 在发布事务内写入；提交后通知消费者，派发失败可重试。测试“数据库已提交、通知未发送”后重启。

---

## 四、存量迁移

- [ ] **24. [P1] 迁移题目的派生草稿只继承内容，没有继承文件引用**
  - **位置**：[0103_version_backfill.sql:94](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/drizzle/0103_version_backfill.sql#L94)、[draft.ts:137](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/catalog/services/versioning/draft.ts#L137)
  - **现象/风险**：迁移创建版本文件引用；无草稿时只派生版本 content，而文件读取只查草稿引用表。存量题第一次编辑可能丢包；OI 仅改题面也会因缺少文件引用无法发布。
  - **修复建议**：首次物化草稿时原子复制基线内容和全部文件引用，或迁移直接建立对应草稿。使用有支持包、checker、测试点的存量 PostgreSQL 数据验证。

- [ ] **25. [P1] 历史平台失败被统一迁移成正式有效判定**
  - **位置**：[0103_version_backfill.sql:127](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/drizzle/0103_version_backfill.sql#L127)
  - **现象/风险**：普通历史结果统一写 `finished/graded`，并进入未知版本桶、设置 `is_valid=true`，没有区分 SE、内部错误等平台失败。通过率分母和结算语义因此被改变。
  - **修复建议**：按可信旧状态及已有归因分类；平台失败保留为最近尝试，但不能建立正式判定桶。迁移夹具至少包含 AC、WA、CE、用户超时、SE 和 AI 基础设施失败。

---

## 五、尝试、结果协议与有效投影

- [ ] **26. [P1，并发/崩溃] 创建提交、创建尝试和更新活动指针不是一个事务**
  - **位置**：[submissions-crud.ts:581](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/submission/services/submissions/submissions-crud.ts#L581)、[attempts.ts:113](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/submission/services/versioning/attempts.ts#L113)
  - **现象/风险**：`createAttempt()` 默认使用根数据库，先插尝试再更新提交；主要调用点没有统一源提交锁。崩溃可能产生无尝试提交，竞争可能覆盖活动指针或发生 sequence 唯一冲突。
  - **修复建议**：唯一写入服务在同一事务锁提交、检查活动尝试、分配 sequence、写尝试和活动指针、关联派发记录。初次提交的源记录也进入该事务。

- [ ] **27. [P1] 批重测没有同步及透传 `rejudge_seq`**
  - **位置**：[attempts.ts:143](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/submission/services/versioning/attempts.ts#L143)、[dispatch-job-item.ts:413](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/submission/services/versioning/dispatch-job-item.ts#L413)
  - **现象/风险**：创建尝试没有更新提交序号，派发没有传尝试 sequence；结果入口缺省序号为 0。旧提交已有 `rejudge_seq>0` 时，合法批重测结果会先被判为过时。
  - **修复建议**：锁内统一源序号与尝试 sequence；所有任务、恢复和结果严格使用该序号。兼容迁移前较大的源序号，测试旧序号 5 的提交再次重测。

- [ ] **28. [P1] 结果封套没有完整校验，而且被忽略的尝试仍可能产生副作用**
  - **位置**：[submissions-result.ts:118](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/submission/services/submissions/submissions-result.ts#L118)、[result-write.ts:130](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/submission/services/versioning/result-write.ts#L130)
  - **现象/风险**：优先读取 evaluator `details.run_id`，允许旧协议兜底；没有完整校验协议、源提交、版本、sequence 与 attempt/run 的一致性。外层先更新提交状态，内部 ignored 后仍继续 SSE 等处理。Rust 封套也没有完整落实要求的 `attempt_id`。
  - **修复建议**：强制可信 v2 封套；`attempt_id=run_id`，与当前活动尝试、源、题目、版本和 sequence 全部匹配。验证失败应零写入、零事件、零清理；禁止用 details 代替可信封套字段。

- [ ] **29. [P1] 非法评分 JSON 会被转成正式零分或满分，替换已有成绩**
  - **位置**：[dual/mod.rs:1087](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/../noj-judge/src/dual/mod.rs#L1087)
  - **现象/风险**：缺少 score、字符串 score 等被 `unwrap_or(0)` 转成零分；越界分数被 clamp。只要 JSON 能解析，缺少 status 默认 finished，继而成为 graded。
  - **修复建议**：要求合法对象及范围内整数评分；不合法评分属于平台错误，保留已有正式判定。测试已有 AC 后 evaluator 输出 `{}`、字符串分数、越界分数，当前判定不能被覆盖。

- [ ] **30. [P1，并发] 策略切换与结果写入没有使用同一锁顺序**
  - **位置**：[result-write.ts:77](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/submission/services/versioning/result-write.ts#L77)、[projection.ts:328](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/submission/services/versioning/projection.ts#L328)
  - **现象/风险**：结果只锁提交；策略修改锁策略行，而重算先读候选再更新提交。策略事务可以读到旧候选、等待结果事务结束后再用旧计划覆盖新投影；题库和竞赛策略同时修改也可能互相覆盖另一作用域字段。
  - **修复建议**：严格采用 Handbook §5.1 的宿主→提交→尝试→revision 顺序，结果取共享宿主锁，策略取更新锁；取得锁后才计算投影。补真实 PostgreSQL 屏障测试。

---

## 六、批任务

- [ ] **31. [P1] 任务受理与附带策略变更不是原子的**
  - **位置**：[rejudge-jobs.ts:448](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/submission/services/versioning/rejudge-jobs.ts#L448)
  - **现象/风险**：先逐项独立提交策略，再开启任务插入事务。第二项 revision 冲突或任务写入失败，第一项策略已经生效；并发幂等受理也可能先执行重复策略操作。
  - **修复建议**：幂等识别、成员与版本固定、全部 revision 检查、策略修改、任务及条目创建进入同一受理事务。验证第二项失败时第一项与任务全部回滚。

- [ ] **32. [P2] 策略变更作用域只检查题目，没有检查竞赛**
  - **位置**：[rejudge-jobs.ts:585](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/submission/services/versioning/rejudge-jobs.ts#L585)
  - **现象/风险**：只要题目在任务内，就可附带修改另一场竞赛同题的策略。
  - **修复建议**：按规范化任务范围验证允许的 `(contest_id, problem_id)` 及题库作用域，拒绝无关竞赛，并在任何写入前完成检查。

- [ ] **33. [P1] 批任务先创建活动尝试，后执行可能失败的准备步骤**
  - **位置**：[dispatch-job-item.ts:373](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/submission/services/versioning/dispatch-job-item.ts#L373)
  - **现象/风险**：尝试创建后才解析 LLM、支持包和任务配置；这些步骤失败会留下无消息的活动尝试。该路径也没有完整复用当前镜像白名单、资源等平台安全预检。
  - **修复建议**：先准备并验证目标执行上下文，再锁内创建尝试；创建后的永久失败必须统一终结尝试、清理活动指针并保留历史成绩。测试 Provider 停用、包缺失和旧配置违反当前平台规则。

- [ ] **34. [P1] 派发失败重试会把本任务自己的活动尝试当成外部评测跳过**
  - **位置**：[dispatch-job-item.ts:179](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/submission/services/versioning/dispatch-job-item.ts#L179)、[dispatch-job-item.ts:435](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/submission/services/versioning/dispatch-job-item.ts#L435)
  - **现象/风险**：首次创建尝试后入队失败，条目重新 pending；下一轮看到源 `active_attempt_id` 就 skipped，根本没有恢复自身尝试。
  - **修复建议**：派发前持久化条目与尝试关联；属于自身的活动尝试复用，同其他任务冲突才跳过。Redis 失败后恢复必须只存在一次尝试。

- [ ] **35. [P1，并发] 结果先到时找不到批任务条目，任务可能永久 dispatched**
  - **位置**：[dispatch-job-item.ts:433](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/submission/services/versioning/dispatch-job-item.ts#L433)、[result-write.ts:215](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/submission/services/versioning/result-write.ts#L215)
  - **现象/风险**：消息先发送，之后才写条目 `attempt_id`。快速结果查询不到关联条目，后续派发状态写入又没有终态可保护。
  - **修复建议**：发送消息前持久化关联；派发更新检查尝试终态，恢复时对已完成尝试补齐条目。测试结果在 `pushJudgeTask()` 返回前落库。

- [ ] **36. [P1] 升级派发重试会重复生成新提交或留下孤儿**
  - **位置**：[dispatch-job-item.ts:531](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/submission/services/versioning/dispatch-job-item.ts#L531)、[dispatch-job-item.ts:471](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/submission/services/versioning/dispatch-job-item.ts#L471)
  - **现象/风险**：每次执行重新生成提交 UUID，没有恢复既有 `result_submission_id`。代码升级 deferred 后再次执行会再造一条；客观题插入、判卷和条目关联也存在崩溃窗口。
  - **修复建议**：新提交、尝试及任务条目关联一次性原子创建，重试仅恢复该副本。连续队列满及各写入阶段崩溃后，实际新增提交数必须仍为 1。

- [ ] **37. [P1，并发] Lease 没有持续续租及阻止过期 worker 写入的机制**
  - **位置**：[job-worker.ts:74](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/submission/services/versioning/job-worker.ts#L74)、[dispatch-job-item.ts:613](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/submission/services/versioning/dispatch-job-item.ts#L613)
  - **现象/风险**：一次领取 100 条后顺序处理，后面的 lease 可能尚未开始就过期；仅在入队前续租且忽略失败返回。完成、重排等更新没有验证持有者，旧 worker 可覆盖新 worker。
  - **修复建议**：只领取能及时执行的工作，执行期间持续续租；业务副作用和 worker 状态更新验证 owner、有效租约及领取代次。双 worker 加长 IO 测试必须没有重复升级与过期写入。

- [ ] **38. [P2] 网络失败被当成队列满，不执行要求的退避及终态清理**
  - **位置**：[producer.ts:58](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/submission/mq/producer.ts#L58)、[job-worker.ts:224](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/submission/services/versioning/job-worker.ts#L224)
  - **现象/风险**：除消息过大外几乎全部错误返回 retryable，派发处却把 retryable 一律解释成容量不足，失败次数不增加。达到失败上限的其他路径又只结束条目，没有统一结束活动尝试。
  - **修复建议**：明确区分容量、网络和永久错误；网络按五次指数退避，永久终止同时更新尝试、源活动状态、条目和 token 生命周期。

- [ ] **39. [P2，并发] 任务聚合状态可能从 completed 被改回 running**
  - **位置**：[rejudge-jobs.ts:703](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/submission/services/versioning/rejudge-jobs.ts#L703)
  - **现象/风险**：聚合读取与任务更新没有原子关系。较早读取“还有条目”的调用，可能在较晚调用写 completed 后再写 running。
  - **修复建议**：锁任务行后在事务内聚合并更新，或使用原子聚合更新 SQL，禁止过时结果回退终态。并发完成最后两条测试。

- [ ] **40. [P2] 重试任务的幂等身份不包含来源任务和重试条目**
  - **位置**：[rejudge-jobs.ts:732](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/submission/services/versioning/rejudge-jobs.ts#L732)
  - **现象/风险**：hash 只取原请求去掉策略，`retry_of` 没参与；也缺少完整幂等键校验、父任务 kind 校验和并发唯一冲突处理。不同父任务可错误返回同一个重试任务，升级任务还可能被解释成重测。
  - **修复建议**：hash 包含任务类型、父任务 ID、规范化条目及固定目标映射；统一入口校验和并发幂等处理。不同父任务同键应 409。

- [ ] **41. [P2] 整题、整场任务虽然没有 500 限制，但单条 INSERT 存在实际规模上限**
  - **位置**：[rejudge-jobs.ts:493](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/submission/services/versioning/rejudge-jobs.ts#L493)
  - **现象/风险**：全部成员拉入内存，再一次插入所有条目；大任务会超过 PostgreSQL 参数限制并造成大量内存占用。重试同样如此。
  - **修复建议**：在保持受理成员集合一致的事务内分批插入，或用数据库集合操作固定成员；后台仍分批执行。至少验证上万条、含两类提交的整场任务。

---

## 七、用户升级

- [ ] **42. [P1/P2] 升级绕过正常提交权限和限制，同时缺少管理员代原用户升级能力**
  - **位置**：[upgrade-jobs.ts:220](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/submission/services/versioning/upgrade-jobs.ts#L220)、[dispatch-job-item.ts:532](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/submission/services/versioning/dispatch-job-item.ts#L532)
  - **现象/风险**：受理主要检查来源所有权，worker 直接插提交，没有完整重用当前题目可访问性、参赛资格、赛期及正常逐提交限制。作业限流不等于提交限流。另一方面，owner 必须等于 actor，使管理员无法代他人升级。
  - **修复建议**：分开“操作者授权”与“原用户正常提交资格”；管理员管理入口可代执行，但新提交归原用户，并记录 actor。每条升级仍经过正常权限、配额和竞赛检查。验证权限撤销、赛期结束及限额已用尽。

- [ ] **43. [P1] `source_contest` 没有按最新版升级，客观题还会静默变成练习提交**
  - **位置**：[upgrade-jobs.ts:239](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/submission/services/versioning/upgrade-jobs.ts#L239)、[dispatch-job-item.ts:458](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/submission/services/versioning/dispatch-job-item.ts#L458)
  - **现象/风险**：目标直接选择固定竞赛版本，而不是先固定最新版再检查等于固定版本；客观题不管 context 都落 `contest_id:null/practice`。
  - **修复建议**：最新版在受理时固定，source_contest 不匹配固定版本则失败；客观题不得产生第二次竞赛提交，也不能自动改练习。只有用户明确选择 practice 才创建练习副本。

---

## 八、竞赛策略、榜单和结算

- [ ] **44. [P1] 保存竞赛题目列表会重置已有有效策略**
  - **位置**：[contests.ts:603](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/contest/services/contests.ts#L603)
  - **现象/风险**：整体删除重插只保存了 pinned version，没有保存 mode、required version 和 revision，重新插入后回到 any/0，且提交投影未同步重算。
  - **修复建议**：未改变关联原位更新标签、排序等信息，保留全部策略字段；策略只能通过专门服务改变。测试 exact 策略下保存同一题目列表和重新排序。

- [ ] **45. [P1] 客观题竞赛榜单仍使用最近分数，而不是有效成绩指针**
  - **位置**：[contest-ranking.ts:366](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/contest/services/contest-ranking.ts#L366)
  - **现象/风险**：客观题分支读取 `os.score`，不检查 `is_contest_valid`。any 下 V1 满分、V2 错误会丢旧成绩；exact 下没有目标版本判定仍可能计旧分。正式归因只关联普通提交，客观题尝试信息缺失。
  - **修复建议**：两类提交统一读取竞赛有效尝试、版本及该尝试 sequence，保留原提交时间。覆盖 any/exact 切换和跨版本重判。

- [ ] **46. [P1，并发] 正式成绩发布不是一致性快照，也没有检查尚未启动的批任务**
  - **位置**：[contest-ranking.ts:29](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/contest/services/contest-ranking.ts#L29)
  - **现象/风险**：赛期、结算和排名都在快照事务外读取；事务仅锁竞赛分配快照编号。queued/preparing 批任务尚未创建尝试时也不进入结算门禁。
  - **修复建议**：在与结果、策略、任务受理协调的锁协议下，同一一致性事务读取结算条件、策略、排名并保存快照；检查相关非终态任务条目。测试发布与任务受理、结果落库和策略切换竞争。

- [ ] **47. [P1] 结算通过字符串状态判断完成，误判正式超时，并忽略客观题平台失败**
  - **位置**：[contest-ranking.ts:136](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/contest/services/contest-ranking.ts#L136)
  - **现象/风险**：正式 `TimeLimitExceeded` 等结果字符串不在 finished/error 中，可能永久计 pending；客观题分支把 platform_error 固定为 false，且没有按尝试状态检查活动执行。
  - **修复建议**：使用 `evaluation_attempts.state/result_kind` 分类；graded 的 WA、CE、用户超时均是完成，平台错误才失败。客观题采用同一规则。

---

## 九、缓存与全部成绩读取

- [ ] **48. [P1] 全局缓存 revision 没有随成绩或策略变化递增**
  - **位置**：[projection.ts:271](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/submission/services/versioning/projection.ts#L271)、[stats-cache.ts:86](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/query/services/stats-cache.ts#L86)
  - **现象/风险**：投影写入只递增 problem/contest，缓存却读取 global。策略已经提交，全局统计仍命中旧键，依赖 TTL；管理仪表盘另外保留了不含 revision 的进程内五秒缓存。
  - **修复建议**：业务事务统一递增所有受影响作用域，包括 global；新增/删除提交影响实际计数时也更新。仪表盘改用 revision 对应的共享缓存。多副本测试策略提交后立即读取。

- [ ] **49. [P2] 物化视图落后时反而不会刷新**
  - **位置**：[rankings.ts:164](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/query/services/rankings.ts#L164)
  - **现象/风险**：`isRankingViewTrusted()` 为 false 就直接退出刷新，导致落后视图无法追平；刷新没有 advisory lock，也不记录覆盖的 revision，仍采用进程内节流。
  - **修复建议**：刷新条件应检查视图存在，而非已可信；用数据库锁串行刷新并记录开始覆盖的 revision。还必须同步修正 [0104 视图定义](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/drizzle/0104_rebuild_user_rankings_view.sql#L10)：两类提交、有效分母、赛期和 `affect_global_ranking` 口径要与内联查询一致，才能安全标可信。

- [ ] **50. [P1] 部分统计仍过滤运行状态 finished，使重测期间已有成绩消失**
  - **位置**：[rankings.ts:323](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/query/services/rankings.ts#L323)、[problems-stats.ts:174](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/catalog/services/problems/problems-stats.ts#L174)
  - **现象/风险**：重测把源状态置 pending，即使有效判定保留，也被统计排除；平台错误后源状态 error，旧有效成绩同样消失。
  - **修复建议**：有效统计以投影和有效尝试为准，运行状态只展示最近执行。回归 AC→重测中→平台失败三个阶段，已有有效通过应保持。

- [ ] **51. [P1] 客观题没有进入多处承诺统一的统计与通过门槛**
  - **位置**：[users-profile-queries.ts:95](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/identity/services/users/users-profile-queries.ts#L95)、[community-post-common.ts:102](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/community/services/community/community-post-common.ts#L102)、[rankings.ts:321](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/query/services/rankings.ts#L321)
  - **现象/风险**：个人资料、全局排行、社区通过门槛等仍只读普通提交。客观题满分不计已通过题数，也可能无法满足题解门槛。
  - **修复建议**：两类源建立统一聚合输入，共用权限和竞赛过滤，按题目 ID 去重。测试仅通过客观题的用户及同题多次练习提交。

- [ ] **52. [P2] 实际提交数和有效分母仍混用**
  - **位置**：[problems-stats.ts:157](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/catalog/services/problems/problems-stats.ts#L157)、[dashboard.ts:106](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/query/services/dashboard.ts#L106)
  - **现象/风险**：题目统计先 inner join 有效尝试，无法再得到实际总数；排行通过率仍用全部行作分母；仪表盘把有最近尝试视为已判定，包含平台错误和当前无效成绩。
  - **修复建议**：实际总数独立统计，公开通过率分母为当前有效正式判定数，返回明确的 total/valid 字段。验证 exact 排除旧成绩、平台错误、新提交未完成和升级新增提交。

---

## 十、客户端与 CI

- [ ] **53. [P2] 版本选择、有效成绩和完整尝试历史没有完整交付**
  - **位置**：[题目详情:280](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-ui/pages/problems/%5Bid%5D.vue#L280)、[提交详情服务:818](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/submission/services/submissions/submissions-crud.ts#L818)、[客观题响应:409](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-core/src/domains/objective/services/objective-submissions.ts#L409)
  - **现象/风险**：题目页只有版本徽标；提交接口只提供每版本当前判定，没有完整尝试历史及清晰分开的最近结果/有效结果；客观题响应连版本、有效性和升级来源字段也未完整返回。
  - **修复建议**：补版本选择并贯穿模板、小题、提交；提供经过一致权限裁剪的有效结果、最近执行、全部尝试历史，两类提交一致。验证 any 下“有效已通过、最近运行 WA”以及同版本多次重测。

- [ ] **54. [P2] 管理批重测界面有三个确定的功能缺陷**
  - **位置**：[submission-jobs.vue:110](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-ui/pages/admin/submission-jobs.vue#L110)
  - **现象/风险**：①统一版本号只查最新 100 个版本，老 V3 存在也会被判不存在；②手选全部强制为普通提交，客观题分支又读取 `problem_id` 而实际响应是 `paper_id`；③输入提示接受题号/公开 ID，却直接提交给按内部 ID 查询的服务，可能生成零条任务。
  - **修复建议**：补完整版本号查询、提交类型选择及正确字段映射，受理前统一解析外部标识。分别测试第 101 个历史版本、客观题手选、P 题号和竞赛公开 ID。

- [ ] **55. [P2] 编辑器中的支持包上传可能创建另一道题**
  - **位置**：[SupportPackageUpload.vue:72](https://github.com/Neuro-OJ/neuro-oj/blob/061ff7d0/noj-ui/components/admin/SupportPackageUpload.vue#L72)
  - **现象/风险**：组件虽然具有 `problemId`，请求却只上传文件到通用 import-bundle，没有传目标题目或草稿 revision。普通用户路径创建新题，管理员也依赖包内题号匹配；随后却向原编辑器报告上传成功。
  - **修复建议**：使用明确目标题目和 revision 的草稿上传/导入入口，校验包身份并返回新 revision。测试为已有 U 题上传，题目数量不能增加，引用必须绑定原题草稿。

- [ ] **56. [P2，CI] LMCC 红灯原因已确认是格式，不是已确认的类型错误**
  - **证据**：[失败 job](https://github.com/Neuro-OJ/neuro-oj/actions/runs/38056356357/job/114225620111)
  - **现象/风险**：`npm run check` 在 Prettier 检查 `src/types.ts` 时退出，后面的 `tsc` 尚未执行。当前没有 pending job，其余检查已通过，包括浏览器和 Judge 沙箱 E2E。
  - **修复建议**：使用该模块固定的 Prettier 配置格式化此文件，再运行完整 check 和测试；格式检查转绿后才能判断是否还有类型错误。

---

## 修复与验收建议

1. **执行次序**：
   - 先解决版本执行来源、产物删除、权限裁剪和删除原子性（#1–#5, #10–#13, #15, #16, #18）；
   - 再统一尝试写入、结果协议、策略锁及批任务恢复（#7–#9, #26–#30, #31, #33–#37）；
   - 随后修正存量迁移、全部读取口径和客户端（#6, #24–#25, #42–#56）。
2. **拒绝过度兼容**：
   - 不要通过增加更多兼容回退来掩盖版本缺失或恢复配置不完整；“完全未发布题目回退未知版本”“管理员不能代升级”等遗留项直接违反 Handbook，不可作为已交付。
   - **旧整题重测入口默认 `submitted` 符合 Handbook，本身无需改变**。
3. **关键验收补充**：
   - 补充未覆盖组合：V1/V2 配置明显不同、已有成绩期间重测失败、共享文件补偿、派发失败后恢复、结果早于关联写入、过期 worker 竞争、策略与结果并发、存量数据迁移。
   - 锁、租约及外键场景必须使用真实 PostgreSQL 屏障测试验证。

---

## 修复轮次执行记录（2026-10-10）

> 状态口径：`已修` = 行为已按“修复建议”落地并有测试；`已核实` = 复核后确认现有实现已满足“修复建议”，补充证据与回归测试锁定。
> 迁移与并发/锁用例在**真实 PostgreSQL**上执行；其余域测试按 `deno task test:domain` 的既有环境执行。

### 一、版本绑定与实际作答、评测内容

| # | 结论 | 主要改动 | 验证 |
|---|---|---|---|
| 1 | 已核实 | 初次提交/产物提交的内容、运行配置、LLM、支持包、产物上限全部取 `resolveSubmissionVersion` 的已解析版本（`submissions-crud.ts`、`artifact-submissions.ts`） | `versioning-execution-context.test.ts`（V1/V2 配置不同、产物上限按版本） |
| 2 | 已修 | 新增 `buildVersionResponseOverrides`（`catalog/routes/problems.ts`）：默认详情与 `?version_id=` 都走版本内容；竞赛题面经同一 `projectProblemContent` DTO（`contest/services/contests.ts`） | `catalog/tests/routes/problem-versions.test.ts`、`contest/tests/services/contest-version-reads.test.ts` |
| 3 | 已修 | 客观题小题新增 `resolveAnswerVersion`/`listPaperQuestions(versionId)`；竞赛固定版本经 `ContestAccessInfo.pinnedVersionId` 强制 | `objective-questions-version.test.ts`、`contest-objective-questions-version.test.ts` |
| 4 | 已修 | `resolveProblemTemplate` 接受目标版本；已发布版本的空模板返回 null，不再回退当前源码 | `support-package-versioning.test.ts`、`problem-bundle.test.ts` |
| 5 | 已修 | 新增 `catalog/services/versioning/version-read-view.ts`（`projectProblemContent` / `trimProblemContentForViewer` / `buildProblemVersionRead`），历史详情与版本内容共用同一裁剪 | `problem-versions.test.ts`（非编辑者不下发评测配置/模板） |
| 6 | 已核实 | 代码、产物、客观题、自测四入口缺 `version_id` 一律拒绝，未发布题目不可建未知版本提交（`submission-version.ts` 无条件 `versionRequired()`） | 各入口「缺版本不产生记录」用例 |
| 7 | 已修 | 竞赛固定版本在提交事务加锁后复查，变更返回 `409 CONTEST_PROBLEM_VERSION_CHANGED` | `versioning-lock-order.pg.test.ts`、`contest-submit-version.test.ts` |
| 8 | 已修 | 自测的配置、样例、支持包全部取所选版本并持久化实际用例快照（`self-tests.ts`） | 「V1 自测中发布 V2 + 自定义用例崩溃恢复」用例 |
| 9 | 已修 | Sweeper 改为从尝试绑定的版本快照恢复；LLM 必须来自快照，缺快照按平台错误处理（`mq/pending-recovery.ts`） | 2 个恢复用例（缺快照不入队、冻结快照恢复） |

### 二、对象存储与删除

| # | 结论 | 主要改动 | 验证 |
|---|---|---|---|
| 10 | 已修 | 结果写入全路径不再物理删除产物；入队失败保留对象且提交保持可恢复 pending | `versioning-execution-context.test.ts`、sweeper 恢复用例 |
| 11 | 已修 | 上传补偿统一经 `deleteStorageObject` 引用守卫，不再直接 `storage.delete()` | 「两请求同字节，失败方补偿不删共享对象」用例 |
| 12 | 已修 | 登记行锁 + 全引用检查 + 物理删除在同一事务内（`system/services/storage/registry.ts`） | `versioning-lock-order.pg.test.ts`（真实 PG 屏障） |
| 13 | 已修 | `verifyStorageObject` 只在明确 NotFound 时置 `missing`，网络/权限异常上抛且状态不变 | `storage-registry.test.ts`（注入 ETIMEDOUT/403） |
| 14 | 已修 | `deleting` 可续做；重传成功后行锁内恢复 `ready` | `storage-registry.test.ts`（崩溃遗留 + 删除后重传同字节） |
| 15 | 已修 | 整题删除固定锁顺序、锁内拒绝在途尝试、数据库清理单事务、对象清理走守卫 | `problems.test.ts`（活动评测拒删） |

### 三、草稿、发布与导入

| # | 结论 | 主要改动 | 验证 |
|---|---|---|---|
| 16 | 已修 | 草稿接口复用 `assertSensitiveFieldPermissions`/`enforceResourceLimits` + 结构校验（`content-security.ts`） | `publish-hardening.test.ts`「#16」 |
| 17 | 已修 | 客观题快照统一强校验器，小题编辑/导入/整卷/发布共用 | `objective-snapshot-validation.test.ts`（7 例） |
| 18 | 已修 | 已发布题型不可变更（`409 CONTENT_KIND_IMMUTABLE`）；导入内容只写草稿，公开投影只由发布更新 | `publish-hardening.test.ts`「#18」 |
| 19 | 已核实 | 管理信息与草稿写入同一事务，校验早于写入 | `problems-tags.test.ts` 过期 409 |
| 20 | 已修 | 内容与文件引用共用一个 revision；发布在锁内重算 hash 并与预检报告比对 | `publish-hardening.test.ts`「#20」 |
| 21 | 已修 | `unchanged` 只与当前最新版比较（A→B→A 生成 V3） | `publish-hardening.test.ts`「#21」 |
| 22 | 已修 | 新发布版本必须取得真实 SHA，取不到返回 `409 STORAGE_OBJECT_SHA_UNKNOWN` | `publish-hardening.test.ts`「#22」 |
| 23 | 已修 | 审计与 `search_entries` 索引在发布事务内写入，提交后 Redis 通知降级为加速 | `publish-hardening.test.ts`「#23」 |

### 四、存量迁移

| # | 结论 | 主要改动 | 验证 |
|---|---|---|---|
| 24 | 已修 | 首次物化草稿时原子复制基线内容与全部文件引用（`versioning/draft.ts`）；迁移 `0109` 为已有草稿行补齐引用 | `publish-hardening.test.ts`「#24」、`tests/db/pr622_review_migration_test.ts` |
| 25 | 已修 | 迁移 `0109_legacy_platform_errors.sql` 把 SE/FE/cancelled/AI 基础设施失败改写为 `platform_error`，清空有效成绩投影并保留最近尝试 | `tests/db/pr622_review_migration_test.ts`（真实 PG：AC/WA/CE/用户超时/SE/FE/cancelled/AI 失败八类） |

### 五、尝试、结果协议与有效投影

| # | 结论 | 主要改动 | 验证 |
|---|---|---|---|
| 26 | 已修 | 提交、尝试、活动指针、派发关联在同一事务内创建（`submissions-crud.ts` / `artifact-submissions.ts`） | `versioning-attempt-pipeline.test.ts`、`versioning-execution-context.test.ts` |
| 27 | 已修 | 新尝试 `sequence = max(MAX(attempt)+1, 提交行 rejudge_seq)`，兼容迁移前较大的源序号 | `versioning-execution-context.test.ts`（旧 `rejudge_seq=5` 再重测） |
| 28 | 已修 | 强制可信 v2 封套；尝试/提交/题目/版本/sequence/run_id 全量一致；ignored 在写事件前返回，零副作用；Rust 侧补齐封套字段 | `versioning-result-write.test.ts`、`noj-judge/tests/judge_result_contract.rs` |
| 29 | 已修 | core 与 Judge 双侧：非法评分（缺失/字符串/越界/非整数）按平台错误处理，不覆盖已有正式判定 | `sanitize-judge-result.test.ts`、`noj-judge/src/dual/tests.rs` |
| 30 | 已修 | 结果写入对题目取共享锁、策略切换对策略宿主取更新锁，严格按 §5.1 顺序 | `versioning-lock-order.pg.test.ts`（真实 PG 屏障） |

### 六、批任务

| # | 结论 | 主要改动 | 验证 |
|---|---|---|---|
| 31 | 已核实 | 受理事务已包含幂等识别、成员固定、revision 检查、策略与条目创建 | 「第二项策略失败整体回滚」用例 |
| 32 | 已修 | 策略变更作用域在**任何写入前**按 `(contest_id, problem_id)` 校验 | 「范围外竞赛 400 且零写入」用例 |
| 33 | 已修 | 派发前完成执行上下文预检（`assertExecutionPreflight`：语言/模式/镜像白名单/资源/产物上限），失败写稳定原因码且不建尝试 | `versioning-dispatch-preflight.test.ts` |
| 34 | 已核实 | 复用条目自身在途尝试，不误判为外部评测 | 「队列容量不足重排后不跳过」用例 |
| 35 | 已修 | 条目与尝试关联在推送消息前落库；派发状态写入不覆盖终态 | `versioning-job-open-items.test.ts` |
| 36 | 已修 | 升级复制副本一次性原子创建，重试复用同一尝试与 `result_submission_id` | 「连续队列满后只新增 1 条提交」用例 |
| 37 | 已修 | 执行期间持续续租心跳；写侧按 owner + 有效租约 + 领取代次条件更新 | `versioning-job-concurrency.test.ts`（含真实 PG 双 worker SKIP LOCKED） |
| 38 | 已修 | 队列错误三分类（capacity/network/permanent）；网络指数退避 1/2/4/8/16s，永久错误立即终态并统一终结尝试 | `versioning-producer-errors.test.ts`、`versioning-job-concurrency.test.ts` |
| 39 | 已修 | 聚合在任务行锁内同事务统计更新，禁止过时统计回退终态 | 真实 PG 并发聚合用例 |
| 40 | 已修 | 重试幂等身份包含父任务类型/ID、规范化条目与固定目标映射，并处理 23505 并发冲突 | `versioning-rejudge-accept.test.ts` |
| 41 | 已修 | `insertJobItemsBatched` 分批插入，受理/重试/升级三路径统一，成员集合仍在受理事务内固定 | 250/5200 条分批用例 |
| 42 | 已修 | 操作者授权与原用户提交资格分离；管理员可代升级且新提交归原用户、actor 记入尝试 | `versioning-upgrade-access.test.ts` |
| 43 | 已修 | `source_contest` 先固定最新版并要求等于竞赛固定版；客观题不产生第二次竞赛提交、不自动改练习 | `versioning-upgrade-access.test.ts`、`versioning-upgrade-jobs.test.ts` |

### 七、用户升级

| # | 结论 | 主要改动 | 验证 |
|---|---|---|---|
| 42 | 见上 | 同 §六 #42 | — |
| 43 | 见上 | 同 §六 #43 | — |

### 八、竞赛策略、榜单和结算

| # | 结论 | 主要改动 | 验证 |
|---|---|---|---|
| 44 | 已核实 | 保存竞赛题目列表原样保留 `pinned_version_id`/`effective_version_mode`/`required_version_id`/`effective_policy_revision` | `contest-version-reads.test.ts`（重排两次仍保留） |
| 45 | 已修 | 客观题榜单改读 `contest_effective_attempt_id` + `is_contest_valid`，保留原始提交时间 | `contest-ranking.test.ts`、`contest-version-reads.test.ts` |
| 46 | 已修 | 结算门禁纳入 `pending/preparing/dispatched`；发布在一致性事务内锁问题/竞赛并读取策略与榜单 | `contest-settlement-gate.test.ts`、`contest-settlement-consistency.pg.test.ts`（真实 PG 屏障） |
| 47 | 已修 | 用 `evaluation_attempts.state/result_kind` 分类（正式 TLE/CE 属完成，平台错误才失败），两类提交同规则 | `contest-settlement-gate.test.ts` |
| 48 | 已修 | 投影与提交创建/删除在业务事务内递增 problem/contest/**global** revision；缓存键含 revision | `stats-cache.test.ts`、`versioning-execution-context.test.ts` |
| 49 | 已修 | 视图存在即刷新（不再要求已可信）、advisory lock 串行、记录覆盖 revision；`0108` 赛期守卫与内联查询逐字一致 | `rankings-view-refresh.pg.test.ts`（真实 PG） |
| 50 | 已修 | 有效统计以投影与有效尝试为准，不按运行状态过滤 | `unified-effective-stats.test.ts`（AC→重测中→平台错误不回退） |
| 51 | 已修 | 个人资料/全局排行/社区题解门槛统一读两类提交并按题目去重 | `users-profile-unified-stats.test.ts`、`community-objective-gate.test.ts` |
| 52 | 已核实 | 题目统计与仪表盘返回 `total_submissions`（实际）与 `valid_submissions`/有效分母 | `unified-effective-stats.test.ts` |

### 九、缓存与全部成绩读取

| # | 结论 | 主要改动 | 验证 |
|---|---|---|---|
| 48 | 见上 | 同 §八 #48 | — |
| 49 | 见上 | 同 §八 #49 | — |
| 50 | 见上 | 同 §八 #50 | — |
| 51 | 见上 | 同 §八 #51 | — |
| 52 | 见上 | 同 §八 #52 | — |

### 十、客户端与 CI

| # | 结论 | 主要改动 | 验证 |
|---|---|---|---|
| 53 | 已修 | core：提交详情/历史读取模型（最近执行 / 有效成绩 / 全部尝试 / 提交时版本 / `is_latest`）、客观题读路径同一命名与权限裁剪；UI：题目页版本选择并贯穿模板/小题/提交、提交详情结果概览与尝试历史、提交列表筛选与批量升级 | core 读模型用例、`noj-ui` `deno task test`（235 passed）、`deno task check:types:nuxt` |
| 54 | 已修 | 管理批重测界面：版本号全分页查询、提交类型选择与 `paper_id` 映射、外部标识统一解析 | `noj-ui` fmt/lint/typecheck/test 全绿 |
| 55 | 已修 | core 新增带目标题目 + `If-Match` 的草稿导入入口（428/409、零写入、`BUNDLE_TARGET_MISMATCH`）；UI 组件强校验响应 id 与目标一致后才报成功 | `publish-hardening.test.ts`「#55」、`noj-ui` 检查 |
| 56 | 已核实 | `noj-lmcc-extension` 当前 `src/types.ts` 已符合 Prettier；`npm run check`（format + tsc）与 `npm test` 全绿 | `npm run check`、`npm test`（10/10） |

### 基线既有失败销账

修复轮次同时清掉了 review 基准提交上**本来就失败**的测试（这些失败与版本管理改造同源，但此前未被 CI 门禁拦住）：

- `catalog/tests/services/problems.test.ts`（更新题目 → 新草稿语义）、`problems-tags.test.ts`、`support-package.test.ts`（服务与路由）、`problem-bundle.test.ts`（4 例导入 + 1 例注入点）共 10 例；
- `identity/tests/routes/auth-admin.test.ts`「管理员真删除」（在途评测按新语义 409，已补在途用例）；
- `submission/tests`：重复自测幂等、平台错误不替换判定、run_id 绑定、`versioning-job-worker.test.ts` 重复 seed 冲突；
- `query/tests/services/rankings.test.ts`、`contest/tests/services/contest-ranking.test.ts`、`contest/tests/routes/contest-submit-version.test.ts`（新契约）。

### 验收阶段追加修复（真实 PG 全量回归才暴露的两个缺陷）

在「真实 PostgreSQL 全量域回归」阶段又定位并修复了两个会让验收假红/假绿的缺陷，二者此前被误判为"环境差异"：

1. **测试事务在真实 PG 下不生效**（`src/shared/db/connection.ts`）。连接池是首次 `getDb()` 才懒创建的，而 `startRealTransaction()` 在 `_client` 为空时直接 `return`，于是**测试进程的第一个触库用例不在事务内**：其写入自动提交、不被 preload 回滚（PGlite 模式因模板实例启动期即就绪而不受影响，这正是"PGlite 绿、PG 红"的原因）。修复：PG 分支先显式初始化连接池再 `BEGIN`。
2. **fire-and-forget 的物化视图刷新与测试事务的 savepoint 交错**（`src/domains/query/services/rankings.ts`）。结果写入后会 `refreshRankingsView().catch(...)`，它在**测试的长事务内**创建/释放 savepoint，与用例自身的 savepoint 记账**交错竞争**，导致 `savepoint "noj_sp_N" does not exist` → `current transaction is aborted` 的级联假失败。
   - **根因勘误（2026-10-11）**：此前把根因写成"PG 25001：`REFRESH MATERIALIZED VIEW CONCURRENTLY` 不允许在事务块内执行"是**错误的**。PG 16.15 实测 `BEGIN; REFRESH MATERIALIZED VIEW CONCURRENTLY ...; ROLLBACK;` **成功**，该语句本身允许在事务块内执行（本函数的正式实现也正是"同一事务内取锁 → 刷新 → 记账"）。真实原因是异步刷新与测试事务的 savepoint 交错。
   - 修复：`connection.ts` 把 savepoint 事务**串行化**（同一条测试连接上兄弟事务不得交错）并让记账错误正常抛出（不再吞 `3B001/25P02`）；`refreshRankingsView()` 额外保留 `isInsideTestTransaction()` 短路，作为**测试适配**（测试期读取一律走内联查询，跳过真跑物化视图重建，被测语义不变）。
3. 相应地，`rankings-view-refresh.pg.test.ts`（专门验证刷新的真实 PG 用例）改为 `disableTestTransactionForFile()`，并保留其自带唯一夹具与显式清理。

修复后真实 PG 全绿：submission **279 passed / 0 failed**（修复前 271/8，连续两次全新 schema 复现）、catalog 328/0、contest 94/0、identity 319/0，`bash scripts/test-shared.sh` 294/0；PGlite 全量域回归同样全绿。

**验收注意**：CI 的每个 job 使用**独立数据库**（先 `00_migrate_test` + `seed_bootstrap_admin_test` 再跑本域）。若在**同一个** schema 里连续跑「shared 套件 → 域套件」，`tests/db/reset-db-tables.test.ts`（`disableTestTransactionForFile()`，会提交式 TRUNCATE）会清掉 RBAC/镜像白名单等种子，使后续域用例出现与代码无关的失败。这不是产品缺陷，按 CI 的「一 job 一库」方式运行即全绿。
2. 真实 PG 全量域回归需在独占库/独占 schema 上串行执行（`test:domain` 会 TRUNCATE），本轮已按此方式执行迁移、锁序、结算一致性、视图刷新、批任务并发用例。
3. **跨模块 E2E 未在本轮运行**：`noj-tests` 的 `test:domain` 需要先 `docker compose -f docker-compose.e2e.yml up -d` 起完整栈（core/judge/llm-mock/minio，端口 8099）。本轮修复环境只起了开发态容器，直接运行会全部 `Connection refused`（`http://localhost:8099` 连接被拒）；尝试启动 E2E 栈时被沙箱的只读 `/home/<user>/.docker/buildx/activity` 阻断，镜像构建无法完成。结论：E2E 必须由具备可写 Docker builder 的环境执行（CI 的 `e2e.yml` 已覆盖 core/judge/gateway 镜像构建与全链路用例）。

---

## 第二轮复审（2026-10-11）10 项遗留缺陷处置

> 基准：复审者在本地工作区（相对 `061ff7d0` 的累计改动）独立复现的 10 项问题。
> 本表记录每项的处置与验收证据；全部改动均在**真实 PostgreSQL 隔离 schema** 上复跑。

| # | 严重度 | 结论 | 关键改动 | 验收证据 |
|---|---|---|---|---|
| 1 | P1 | 已修 | 新增持久化**上传预约**（表 `storage_object_reservations`，生成迁移 `0111`）；物理上传前在登记行锁事务内写入预约、上传成功后消费预约；删除守卫持锁检查未过期预约 → `409 STORAGE_OBJECT_UPLOAD_IN_FLIGHT`，不删物理文件、不置 deleted；`registerReadyStorageObject` 仅凭「自己的 + 同 URL + 未过期」预约才可从 `deleting/deleted` 恢复 `ready`（`system/services/storage/registry.ts`）；调用方 `oi-draft.ts`、`problem-bundle.ts`、`support-package.ts` 统一改为 reserve → put → register | `versioning-lock-order.pg.test.ts` 新增「删除执行期间重传并绑定——绝不出现 ready 但物理缺失」（GatedDeleteProvider 屏障）；`storage-registry.test.ts` 18 例（含过期预约清理、无预约不得复活 deleted、补偿不误删共享对象） |
| 2 | P1 | 已修 | `effective-policy.ts` 新增唯一锁序实现 `lockEffectivePolicyHosts()`：题目升序 → 竞赛升序，一次取全；`acceptRejudgeJob` 在**任何策略写入/投影重算前**对 changes 的题目∪竞赛取全锁，单条入口同序；`testRootDb?` 为**测试专用**可选注入（省略时行为不变） | 新增 `lock-order-policy-cross-contest.test.ts`：两批**题目不相交、竞赛相交**并发受理，确定性屏障复现；临时恢复旧锁序 → 第 1 轮即 `40P01`，修复后 5 轮稳定通过 |
| 3 | P1 | 已修 | LLM token 吊销收敛为统一终态后处理 `revokeAttemptLlmTokens()`，覆盖 finished/error/superseded，四条终结路径（正常结果、job 直提永久失败、重试耗尽、sweeper 永久恢复失败）均在**事务提交后**调用；TTL 由尝试快照推导（≥1h 下限 + 余量），不再写死 3600s；`supersedeAttempt` 也在提交后吊销（传 executor 时不提前吊销） | `versioning-terminal-revocation.test.ts` 6 例（含「派发响应丢失后终结仍吊销」「长寿命 token > 1h 仍被吊销」「superseded 后吊销」） |
| 4 | P2 | 已修 | `connection.ts` savepoint 模拟：**兄弟事务串行化**（连接级 Promise 队列）、**嵌套不离队**（深度计数，避免与外层互等死锁）、成功路径 `RELEASE` 失败**必须抛出**（不再吞 `3B001/25P02`）、回滚失败标记连接事务损坏并保留原始异常 | 新增 `tests/db/test-transaction-savepoint_test.ts` 3 例：交错兄弟事务后 `SELECT 1` 仍成功（旧实现报 `25P02`）、内层失败不中止外层、嵌套事务不死锁 |
| 5 | P2 | 已修 | 新增 `tests/helper/pg-raw-connection.ts`：原生连接统一复用 `buildConnectionOptions(TEST_SCHEMA, jitDisabled)`，提供 `withRawTransaction()` 把「可绑定检查 + 插入引用」放进同一真实事务；`versioning-lock-order.pg.test.ts` 的原生连接全部改走该 helper，并发 Promise 均装拒绝守卫 | 隔离 schema（`TEST_SCHEMA`）下该文件 4 例全绿（修复前 277/3 failed）；`rankings-view-refresh.pg.test.ts`、`contest-settlement-consistency.pg.test.ts` 同样走 helper |
| 6 | P2 | 已修 | 升级副本**首次插入的同一事务**内 `bumpSubmissionCountRevisions(tx, …)`（problem/contest/global）；复用副本提前返回不重复递增；客观题升级副本同样补齐 | `versioning-upgrade-copy.test.ts`「revision#6」两例（含 source_contest 递增竞赛作用域、重派不重复递增） |
| 7 | P2 | 已修 | 新增 `PreparedJobExecution`：**先预分配** attempt/副本 ID、sequence 与完整非敏感快照 → 支持包存在性 + LLM 服务/模型/预算预检（重派用冻结快照，不重解析平台默认）→ 再在**单事务**内落副本/尝试/条目；预检与配置类永久失败**不留尝试行** | `versioning-preflight-order.test.ts` 3 例（Provider 缺配、支持包缺失均 0 尝试；重派用快照 provider/model） |
| 8 | P2 | 已修 | `query_projection_revisions.materialized_at`（生成迁移 `0111`）记录刷新覆盖时刻；`inspectRankingView()` 的新鲜度加入**赛期边界**判定（`materialized_at < c.end_time <= now()` 且 `affect_global_ranking`；`materialized_at IS NULL` 按落后），落后即回退内联并调度刷新；`updateContest`/`deleteContest` 变更赛期或 `affect_global_ranking` 时递增 global data revision | 真实 PG `rankings-view-refresh.pg.test.ts` 4 例：比赛自然结束且**无任何写入** → 视图不再可信、内联口径正确；刷新后再跨边界仍需刷新；改字段立即失效。PGlite `contest-revision-invalidation.test.ts` |
| 9 | P2 | 已修 | 新增 `consumeSubmissionQuotaForUpgrade(sourceUserId, jobItemId)`：与普通提交**共享** `submission:user:<id>` 额度；Lua `SET NX PX` 占位保证幂等（重派不重复扣费，24h）；额度不足释放占位并返回结构化延期；管理员代升级扣**原用户**；**限流总开关关闭时（含测试默认）直接放行**；worker 在副本插入同事务内调用，延期则回滚 + `requeueJobItem` | `upgrade-quota.test.ts` 3 例（延期不失败、重派只扣一次、管理员扣原用户且不占 actor 预算）+ `versioning-upgrade-copy.test.ts`「quota#9」（fail-closed → 条目延期、不发新提交、恢复后重试成功） |
| 10 | P2 | 已修 | 锁内复查的 `SOURCE_JUDGING`/`SOURCE_DELETED` → 条目 **skipped**（租约丢失仍延期；其它 <500 仍 failed），worker 外层兜底同分类 | `versioning-job-skipped.test.ts`（契约）+ `versioning-job-skipped-source.pg.test.ts`（真实 PG 行锁屏障 2 例） |

### 本轮集成验收额外修复（Lead 收口）

- **`RATE_LIMIT_ENABLED` 模块级泄漏**（`upgrade-quota.test.ts`）：测试文件在模块顶层 `Deno.env.set("RATE_LIMIT_ENABLED","true")`，而 Deno 测试文件共享同一进程 → 后续所有文件都被开启限流，升级派发开始扣真实额度并被延期。改为**每用例内**开启、`finally` 还原（与 `routes/self-tests.test.ts` 既有 `withRateLimitEnabled` 同模式）。修复后 submission 整域真实 PG **302 passed / 0 failed**（修复前 294/8）。
- **额度总开关顺序**：`consumeSubmissionQuotaForUpgrade` 原先先碰 Redis 占位再判总开关，Redis 异常会把"未启用限流"误判成"额度不足"；改为总开关优先短路。
- **`retryAfterMs` 兜底**：限流实现可能不返回该值 → `plusSeconds(NaN)` 抛 `RangeError`，把"延期"变成真失败；在 `upgrade-quota.ts` 与 `UpgradeQuotaDeferredError` 构造器各加有限值兜底。
- **删除路径容错**：`submissions-crud.ts` 删除提交后的产物物理清理改为 try/catch（预约未过期时守卫会返回可重试 409，提交行已删除，不能因此让删除失败）。
- **迁移产物归正**：本轮 schema 改动改用 `deno task db:generate` 生成 `0111_clever_khan.sql` + `0111_snapshot.json`（删除此前手写的 `0110`），快照链门禁与 schema parity 均通过；`schema-ddl.ts` 压缩到 1199 行以过单文件规模门禁。

---

## 第三轮复审（2026-10-11）10 项缺陷处置

| # | 严重度 | 结论 | 关键改动 | 验收证据 |
|---|---|---|---|---|
| 1 | P1 | 已修 | sequence **不再在预检阶段冻结**（`PreparedJobExecution` 去掉该字段），由 `createAttempt` 在**源提交行锁内**统一分配；任务封套在提交后用**落库返回的** `attempt.sequence` 回填（`dispatch-job-item.ts`）。存量 `legacy_unknown` + `rejudge_seq=7` 场景落库与封套同为 7 | `versioning-job-sequence.test.ts`（存量场景 + 重派沿用）；真实 PG 屏障「预检期间另一轮评测完成 → 封套仍取落库 sequence」 |
| 2 | P1 | 已修 | 新增 **吊销 outbox** 表 `llm_token_revocations`（迁移 `0112`）：写终态（finished/error/**superseded**）的**同一 DB 事务**内登记 pending 行 → 提交后立即执行吊销并标 done → 失败由 sweeper 周期 `runPendingTokenRevocations()` 持久化重试；TTL 仍由尝试快照推导 | `versioning-terminal-revocation.test.ts`「revoke#2」3 例：Redis 不可用 → pending 且标记缺失、恢复后补偿 done；「终态已提交未吊销时进程退出」→ 新进程补偿；superseded 同样走 outbox |
| 3 | P2 | 已修 | savepoint 模拟改用 **AsyncLocalStorage 按事务节点判定父子**：直接子事务进**该父的子队列**（同父兄弟按序），链外发起进全局兄弟队列；父在 RELEASE 前排空自己的子队列；`RELEASE` 失败必须抛出、回滚失败标记连接损坏 | `tests/db/test-transaction-savepoint_test.ts` **5 例**：同时启动兄弟、**外层已开始后启动的延迟兄弟**、**外层内 `Promise.all` 两个内层事务**、内层失败不中止外层、嵌套不死锁 |
| 4 | P2 | 已修 | `materialized_at` 改为从刷新事务读取 `transaction_timestamp()`（与视图 `now()` 同源），不再用应用时间；等锁跨边界时两者必然同侧 | 真实 PG：①"刷新事务等锁跨过比赛结束" → 不误判 trusted 且内联口径正确；②应用时钟偏移 +1h → 记录值仍落在数据库时钟窗口。A/B：改回 `new Date()` 时两用例必失败 |
| 5 | P2 | 已修 | 占位与扣费合并为**单次原子 EVAL**：幂等标记检查 → `INCR`+窗口 TTL → 超限**不写标记** → 扣费成功才写标记。标记只代表"扣费已完成" | `upgrade-quota.test.ts`：响应丢失后重试不重复扣费；扣费阶段故障注入 → 无标记残留、恢复后正确扣一次；连接重建后幂等 |
| 6 | P2 | 已修 | 额度按**提交类型与上下文**分桶：`code` / `contest_code` / `objective`，与正常提交**同键、同窗口、同阈值**；管理员代升级仍扣原用户 | `versioning-upgrade-quota-bucket.test.ts` 4 例（桶映射、三桶独立、桶耗尽延期、重派只扣一次）+ 额度层桶隔离测试 |
| 7 | P2 | 已修 | 流式上传（无法上传前预测哈希）改为**上传后在登记行锁事务内真实 `stat()` 复核**：存在 → 用服务端元数据恢复 `ready` 并绑定；明确缺失 → `STORAGE_OBJECT_MISSING` 拒绝绑定；stat 抛错 → 原样上抛不改状态 | `storage-registry.test.ts` 4 例（**连续两次重传都成功**、缺失拒绝、stat 抛错、首次上传）；真实 PG `versioning-lock-order.pg.test.ts` 两例（重传循环两轮、删除/流式并发终态只能 ready+存在 或 deleted+缺失，且重试随后成功） |
| 8 | P2 | 已修 | 客观题重判/升级在**源行锁内**复查存在性与活动尝试，统一映射 `SOURCE_DELETED`/`SOURCE_JUDGING` → 条目 **skipped**（与普通提交同分类）；重判分支整段入事务 | 真实 PG 屏障 3 例：重判期间源被删除 → skipped；重判期间源被换活动尝试 → skipped；升级期间源被删除 → skipped 且不留副本 |
| 9 | P2 | 已修 | 我上一轮新增的 `test-transaction-savepoint_test.ts` 有 4 个 lint 错误（3×`require-await`、1×未用 `tx`）。重写用例：回调内真实执行事务查询、去掉多余 `async`/未用参数 | `deno task lint` → **0 问题**（此前 4 errors）。**过程纠正**：上一轮我用 `deno lint \| tail -1` 只看了汇总行，把红灯误报成"通过"——本轮起改用 `deno task lint` 全量输出判定 |
| 10 | P2 | 已修 | `test-parallel.ts` 在启动分片前用 advisory lock **串行完成数据库级公共扩展初始化**并显式 `WITH SCHEMA public`；分片内 `CREATE EXTENSION IF NOT EXISTS` 随之成为空操作 | **全新数据库**上 `test:parallel --shards 2` → **1534 passed / 0 failed / 11 ignored**（修复前该场景 `23505 pg_extension_name_index` 连锁失败） |

### 本轮验收结果（Lead 亲自复跑）

- 真实 PG **全部 15 个域 0 failed**：submission **323**、catalog 328、contest 95、identity 319、system 156、objective 63、query 33、community 72、search 30、admin 16、gateway 23、messaging 67、observability 20、legal 42、content-review 11
- `scripts/test-shared.sh`（真实 PG）**299 passed / 0 failed**
- PGlite：submission 295、catalog 328、contest 94、query 27、objective 63，全 0 failed
- **全新数据库**双分片 `test:parallel`：**1534 passed / 0 failed**
- 静态与门禁：core `fmt` / `lint`（0 问题）/ `deno check`（0 error）、schema parity（68 表）、迁移快照链、单文件规模、`check-ci` 全通过
