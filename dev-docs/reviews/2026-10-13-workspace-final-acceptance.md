# NOJ 工作空间、教学及五赛制升级验收报告

日期：2026-10-13。实现及本地验收已交付，最终 PR／远端 CI 尚未签收。
审查：[PR #643](https://github.com/Neuro-OJ/neuro-oj/pull/643)。
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
| 浏览器              | 原 20 项覆盖＋ClassGov 1＋题包 1          | 完整一次运行 17 通过、3 失败；三个夹具前置流程修复后分别通过，新两项另外实际执行     |
| Schema              | 108 表／985 列 parity                     | 保留主线已发布迁移，标准生成追加；迁移安全、快照链及实际存量回填通过                 |
| 仓库门禁            | 标准 check-ci 全部通过                    | 含 216 个门禁自测、边界／CI 路径／迁移／目录／链接／Note／写频率／跳过棘轮           |

浏览器证据不表述为单次全套全绿；环境忽略、筛选未执行用例不计为通过。
测试均使用标准 `deno task`／项目共享脚本及 `cargo nextest` 入口；直接 Deno
脚本仅用于实际 CLI／备份恢复等运维操作。

## 实际用户旅程

用户进一步要求 API 验收。最新正式 core 上 submission 完整 38 项通过，其余
八项开启真实 S3 后全部通过；cross-domain 完整 55 项、10 步、零忽略通过。
正常后台进度 1109ms、实际重启恢复 2218ms。目标明确为独立栈，没有借用浏览器
或服务单元结果，见
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

100 人×50 题、按 50 人分页，后端矩阵 p95 100.36ms，实际消费者更新 1623.94ms。
最终跨模块正常更新 1309ms，真正 core 重启后的两积压事件恢复 2288ms。
这些是固定场景的后端／消费者测量，不包括浏览器渲染、无界负载或所有故障组合。
完整环境见[性能报告](2026-10-13-education-matrix-performance.md)。

## 代码质量与交付边界

此前 Q1–Q5 简化和参赛维护者客观答案旁路 S1 已修复并有专项回归，见
[质量整改 Note](../../.agents/notes/implemented/process/2026-10-13-workspace-quality-review-and-followups.md)。
本轮不扩展所有管理 PATCH 的通用幂等框架；按批准范围使用 revision、事务与
发布／复制／批量操作幂等。评测结果及题目补丁静态帮助函数拆出，保持门禁文件
规模；界面消息只在 JSON 发送边界转换快照，未增加吞错兜底。

尚待最终签收：PR #643 的最新提交远端 CI 和合入流程。外部邮件、付费 API 与
生产专用 rootless Judge 不在本机 Mock／宿主 Docker 的证据范围内；部署文档
要求生产采用原有安全配置。这不改变本次产品功能交付范围。

明确延后范围与批准计划一致：自定义角色、私有跨域共享、课程学期、多班同作业、 AI
教学诊断、专属 Judge 池、复杂域调度、订阅计费与自定义题号。

## 复验命令与本地证据

```bash
cd noj-core && deno task test:parallel
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
