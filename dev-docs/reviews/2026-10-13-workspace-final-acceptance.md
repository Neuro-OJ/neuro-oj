# NOJ 工作空间、教学及五赛制升级验收报告

更新日期：2026-10-14。实现、API、浏览器及性能验收已交付；合入等待仓库要求的批准
review。 审查：[PR #643](https://github.com/Neuro-OJ/neuro-oj/pull/643)。
依据：[已批准计划](../superpowers/plans/2026-10-12-workspace-education-contest-upgrade.md)、
[106 项任务清单](../superpowers/plans/2026-10-12-workspace-upgrade-tasks.md)。

## 已交付行为

| 范围             | 实际结果与审查依据                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| Instance／Domain | 统一账号，路径解析工作空间，内置组合角色，Preset、申请、邀请、政策与配额治理；JWT 不保存当前域                |
| 题库与版本       | 域内数字编号，来源 `slug:number`，默认 main 兼容入口，绑定独立 any／exact 策略；不可变版本及原 ID 保留        |
| 共享与撤销       | 公开题／题单引用不复制版本字节；当前 DB 授权控制题面、模板、执行、搜索与下载；历史原提交／反馈按受控口径保留  |
| 提交及查询       | 普通、客观、自测、批量／升级明确使用域；错误域 ID 不可访问，私有活动不计公共主页或默认域榜                    |
| LLM 与额度       | 域 Provider／模型别名／revision／RPM／TPM／用量，评测尝试冻结实际模型，组合预占／结算／对账与存储原子容量     |
| 比赛             | Kaggle 最高分、OI／IOI／严格最后受理提交、ACM 首次 AC／罚时／封榜；统一允许字段裁剪，正式快照独立于作业重测   |
| Classroom        | 普通教练与六项可组合助教能力，邀请／CSV／交接／归档；离班历史保留，撤职后重新读取失权                         |
| Assignment       | 发布固定集合／规则，同域候选自动计入多任务；按时与补做分开，动态版本和重测沿革，持久 outbox 依事实重算        |
| 教学工作台       | 分页矩阵、状态筛选／CSV、授权提交及尝试／OI 详情、反馈、不可变提交行批注、求助与独立补题任务                  |
| 客户端           | 显式域 Web／IDE／CLI，域／题／版本／用户草稿键；主线预测／界面题、SDK 结果及运行沿革、题包直接导入与 CLI push |

授权矩阵见[工作空间权限文档](../engineering/workspace-authorization-matrix.md)。
班级交接只改变主教练与接任管理关系，原教练仍任教；明确移除后失权，文档与
真实测试采用这一实现，不把交接误写成自动撤销所有任职。

## 标准测试与范围

| 检查                | 最终本地证据                              | 说明                                                                                 |
| ------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------ |
| core 完整并行       | 2337 通过／0 失败／17 忽略                | 新鲜独立 PostgreSQL；unit 387，DB 1950；随后小路由频率及 #641 夹具单独补验           |
| 教学写频率          | PostgreSQL／PGlite 各 3 项，加各 1 helper | 真实 Redis，121 次写入拒绝、域／用户分离，GET／HEAD 不计写窗口                       |
| #641 core 题包 HTTP | 22 项，初始化 8 项通过                    | 未发布题目标支持包更新与 revision／稳定 ID；core 业务源码未改变                      |
| Gateway             | 127 通过／0 失败／1 忽略                  | 显式启用 PostgreSQL／Redis；忽略项为真实付费 DeepSeek API                            |
| UI                  | 283 单元、250 组件通过                    | 最新 #641 协调源码；格式／lint／Deno／Nuxt／vue-tsc 通过，正式 Docker 二进制构建通过 |
| CLI                 | 767 通过／0 失败／4 忽略                  | 格式／lint／类型及标准 build:cli 通过；真实恢复栈 HTTP push 发布 V1                  |
| Judge               | 631 通过／46 专属跳过                     | nextest／fmt／clippy；预测 Docker 另实际 1 项通过，9 项比赛 Native 已实际执行        |
| LMCC                | 14 项／格式／类型通过                     | 当前宿主相关源码与已有 8 项真实 Extension Host 证据逐字节一致；宿主采用本地模拟 HTTP |
| 跨模块              | 55 项／10 步／0 忽略                      | 真实 Judge、Gateway、S3、五题型作业、故障及进度恢复                                  |
| 浏览器              | 22 项／42 步／0 失败                      | 远端完整启用 Chromium；包含 Public／Private／Mixed、40 人班级及题包导入              |
| 搜索性能            | 4 项／0 失败，完整运行 24m7s              | 真实三次十万行重建，原查询阈值未放宽；独立 PostgreSQL，512MiB 共享内存               |
| Schema              | 108 表／985 列 parity                     | 保留主线已发布迁移，标准生成追加；迁移安全、快照链及实际存量回填通过                 |
| 仓库门禁            | 标准 check-ci 全部通过                    | 含 216 个门禁自测、边界／CI 路径／迁移／目录／链接／Note／写频率／跳过棘轮           |

浏览器最终远端运行是单次全套全绿；早期夹具失败及补验记录保留为实施历史。
环境忽略、筛选未执行用例不计为通过。 测试均使用标准 `deno task`／项目共享脚本及
`cargo nextest` 入口；直接 Deno 脚本仅用于实际 CLI／备份恢复等运维操作。

## 实际用户旅程

用户进一步要求 API 验收。最新正式 core 上 submission 完整 38 项通过，其余
八项开启真实 S3 后全部通过；最终搜索修复 core 上 cross-domain 再完整 55 项、 10
步、零忽略通过。最终生产 Judge 再次全绿，正常后台进度 253ms、实际重启恢复
2248ms。远端实际 contest API 36 项、submission 38＋8 项、cross-domain 55
项全部通过。 目标明确为独立栈，没有借用浏览器 或服务单元结果，见
[最终 API 记录](../../.agents/notes/implemented/testing/2026-10-13-final-api-acceptance.md)。

- Public：注册、main 做题、公开题单、域社区与比赛。
- Private：邀请注册、单域导航、学校班级、实际错误／正确代码、反馈与行批注、
  求助／回复、补题及归档后的历史读取。
- Mixed：公共源题＋两个学校，域身份、同题不同版本、Provider／实际模型／用量
  独立；两个标签页、题目／版本草稿分离，撤销与错误路径拒绝。
- 40 人治理：42 行 CSV（40 合法、2 重复／无效）、真实执行与下载结果；六助教
  能力全授后收窄为学情／反馈，学生原答案 403；按时／补做／历史学生 CSV 与
  390px；补题新 100 分来源及旧 0 分提交均保留；接任后撤职旧教练／TA 404。
- 输入模式：两学校同 CSV 不同策略实评分、界面自测／提交 SDK 回推、运行历史／
  差异／回滚／撤销、跨域草稿及比赛固定 V1。
- 最新题包：非平台管理员的域负责人通过真实 Web 从 ZIP 建草稿，再以导入的
  revision 发布；保留目标域、新题数字编号和同域编辑跳转。

## 迁移、恢复和性能

主线 0113–0115 原样保留，未发布主题迁移统一由生成的 0116 及补充 0117 承载。
存在未经处理的旧 U／旧比赛时迁移拒绝，不自动清除。用户授权的开发数据清理
已先备份、在独立库演练，旧 P 的数字、源 ID、账号与版本保留。 使用真实 main 旧
Schema 的合成普通提交／尝试补足原库没有普通练习历史的情况，
升级后原代码、版本、尝试、有效投影及本人读取保持一致，初始化和搜索幂等。

最新正式加密快照经 create／deep verify／restore 恢复到独立生产配置项目，28
组表、63 个对象逐字节摘要与 87 个日预算完整相同。之后新真实 LLM 提交 100 分、8
tokens，目标域与实例各增加 1 次／8 tokens，其他域不变。最终 core／UI 镜像、正式
CLI push 和最新 Chromium 历史读取另已核验，见
[恢复记录](../../.agents/notes/implemented/testing/2026-10-13-main117-coordinated-backup-restore.md)。

搜索修复后，独立恢复栈再次升级最终 core 镜像
`sha256:8817bbcf716606f51dc5ed98db292469d57fd9d2a37aa737c23e365cef41b451`。 实际
API 登录、历史原版本／尝试／100 分、域模型 alias revision 均保持；新提交
`a8685f33-9a68-4d09-9f3f-3db591d61617` 经 Judge／Gateway 完成 100 分、8 tokens，
Provider／模型／用量仍归使用域。旧完整快照恢复证据与此次最终代码读取／执行
分别记录，没有在已产生新提交后要求历史表摘要仍相同。

100 人×50 题、按 50 人分页，后端矩阵 p95 100.36ms，实际消费者更新 1623.94ms。
最终生产 Judge 的跨模块正常更新 253ms，真正 core 重启后的两积压事件恢复 2248ms。
这些是固定场景的后端／消费者测量，不包括浏览器渲染、无界负载或所有故障组合。
完整环境见[性能报告](2026-10-13-education-matrix-performance.md)。

新增最终搜索基准：十万题真实重建后查询 324ms；十万帖子搜索 P50 131.5ms／ P95
139.5ms；另一组十万题＋一万用户，高选择性题目查询 323ms、全命中题目 查询
280ms、用户查询 37ms；十万次分页解析 8ms。标准 `test:perf` 四项全部通过。
修复重复实时授权 SQL 和索引 builder 的重复来源查询，仍读取当前 DB 授权，
见[性能修复 Note](../../.agents/notes/implemented/bug-fix/2026-10-14-domain-search-benchmark.md)。

## 代码质量与交付边界

此前 Q1–Q5 简化和参赛维护者客观答案旁路 S1 已修复并有专项回归，见
[质量整改 Note](../../.agents/notes/implemented/process/2026-10-13-workspace-quality-review-and-followups.md)。
本轮不扩展所有管理 PATCH 的通用幂等框架；按批准范围使用 revision、事务与
发布／复制／批量操作幂等。评测结果及题目补丁静态帮助函数拆出，保持门禁文件
规模；界面消息只在 JSON 发送边界转换快照，未增加吞错兜底。

首次 PR 的 50 项检查通过，性能 job 按规则跳过；显式手动运行暴露旧基准夹具和
重复授权查询，现已修复并完成完整本地基准。最终手动 Judge 检查又发现取消 WASM
自测时的实际空结果竞态，按中断状态修复，未通过重复重跑掩盖失败，见
[取消修复 Note](../../.agents/notes/implemented/bug-fix/2026-10-14-wasm-cancellation-result.md)。

最终源码 `b501ea84` 的
[PR CI](https://github.com/Neuro-OJ/neuro-oj/actions/runs/38516413582)、
[完整 E2E](https://github.com/Neuro-OJ/neuro-oj/actions/runs/38516413909) 和
[workflow lint](https://github.com/Neuro-OJ/neuro-oj/actions/runs/38516413673)
通过。 额外
[手动全量 CI](https://github.com/Neuro-OJ/neuro-oj/actions/runs/38516422987)
运行默认 PR 跳过的性能 job：搜索四项、教育初始化八项、教育完整 126 项通过；
十万题 226ms、十万帖 P95 116ms、100×50 矩阵 P95 39.57ms、实际消费者更新
1011.16ms。 手动全量 CI 整体也成功。文档收尾提交的检查以 PR
实时记录为准，运行源码没有变化， 不把历史失败运行删去。

生产 Judge 镜像为
`sha256:5b22550c84ba1c8ca7d1708f6b1ac761172ae7050f9483c398430639c78f3f58`，
包含匹配的 WASI SDK。首次误用缺 SDK 的测试镜像启动被拒，造成等待评测超时；
纠正后完整 cross-domain 55 项通过，恢复栈新 LLM 100 分／8 tokens 通过。 新提交
`b8baefe7-c53b-42ff-8c1d-21ae61879c1a` 的 Provider／实际模型与使用域一致。
本地比赛补跑 34 项通过、两条固定旧端口的 SSE 请求 404，不计整套通过；
同一最终源码的远端比赛 API 36 项全部通过，包括这两条 SSE 保密检查。

最终产物恢复栈另创建加密快照 `snapshot-20261014-054053.nojbackup`，557025 字节，
SHA-256 `18af97bc1951371a21e80839f736a389c044413040e5c59f9014c613de72157b`。
最终正式 CLI create／deep verify／sidecar 均通过；文件权限 0600。此新快照的
深度校验和此前完整隔离恢复、数据比对是不同证据，不声称又恢复了新快照。

PR #643
合入尚需批准：[protect main 规则](https://github.com/Neuro-OJ/neuro-oj/settings/rules/17899316)
要求一条批准 review、解决 review 线程且新推送撤销过期批准。没有管理员绕过。
外部邮件、付费 API 与生产专用 rootless Judge 不在本机 Mock／宿主 Docker
的证据范围内；部署文档 要求生产采用原有安全配置。这不改变本次产品功能交付范围。

明确延后范围与批准计划一致：自定义角色、私有跨域共享、课程学期、多班同作业、 AI
教学诊断、专属 Judge 池、复杂域调度、订阅计费与自定义题号。

## 复验命令与本地证据

```bash
cd noj-core && deno task test:parallel
cd noj-core && deno task test:perf
cd noj-core && deno task test:domain catalog --filter import-bundle
cd noj-core && bash scripts/test-shared.sh
cd noj-ui && deno task test && deno task test:components && deno task check
cd noj-cli && deno task test && deno task check && deno task build:cli
cd noj-llm-gateway && deno task test --frozen
cd noj-judge && cargo nextest run --all-targets --locked
cd noj-tests && deno task test:domain cross-domain
cd noj-tests && NOJ_RUN_BROWSER_E2E=1 deno task test:browser
deno run -A scripts/check-ci.ts
```

以上独立模块命令需从根目录分别进入，使用对应隔离 DB／Redis／完整 E2E 栈配置；
Gateway 持久测试和 Native／S3／Browser 需显式启用其真实环境。

本地原始日志：core
`noj-root-core-main-final-parallel-third-20261013.log`；跨模块
`noj-client-main-cross-domain-full-final.log`；Browser 全套及三个补验
`noj-client-main-browser-{full-enabled,governance-final,teaching-final}.log`；班级
`noj-classroom-browser-third.log`；新题包
`noj-root-main641-bundle-browser-final.log`； 正式恢复
`noj-root-main117-restored-final-check.log` 和
`noj-root-main117-final-clients.log`，均位于 `/tmp`。持久审查依据保留在本报告、
专题 Notes 和 PR；临时日志、快照、密钥及构建缓存不提交 main。
