# 域内 UI 修复验收记录

范围：以 `syupslzz / 9b2e3d4c` 为基线，修复真实 UI 功能、域内操作逻辑和布局。
完成标记见[任务清单](../superpowers/plans/2026-10-14-ui-repair-tasks.md)，产品待决事项见
[无人值守决策队列](../../.agents/notes/proposed/process/2026-10-14-unattended-ui-decision-queue.md)。

## 已交付行为

- 根入口进入明确域地址；头像显示 `username@slug`，通过二级菜单切域。
- 移除跨域汇总 UI，旧搜索、提交列表和业务管理链接固定兼容到默认域。
- 三种域都有社区，创建后类型固定；教学域保留学习、班级、作业和教练工作台。
- 题库恢复题号、难度、标签、本人状态和筛选；题目详情提供通过要求、域统计、
  题解、本人历史、样例说明和版本依据。
- 做题页采用桌面双栏与窄屏面板，切换保留代码、选项及已选文件，继续使用域内
  提交、自测、产物、预测与界面题流程。
- 正式 OI
  判定、编译错误与允许的子任务可读，比赛开始/结束会刷新允许的行为和结果。
- 作业矩阵实时重读，教师反馈对象明确到学生；批注仍绑定不可变原提交。
- 后台刷新保留已打开的教学表单和作答面板；产物和预测题明确显示已选文件名。
- 社区索引消息在授权事务提交后发布，避免列表已有帖子而搜索永久缺失。
- 社区首屏失败显示实际错误和重试；LLM 配额区分参考值与实际生效对象。
- 导航角标以 15/30
  秒间隔刷新，避免双标签页常驻连接阻塞业务请求；成绩页继续实时更新。
- 独立本地套件使用不同 Cookie 前缀；A+B 正常发布 V2 结构化样例，历史版本保留。

## 已核实的自动验证

| 验证                   | 当前结果                             | 证据范围                                                                     |
| ---------------------- | ------------------------------------ | ---------------------------------------------------------------------------- |
| core 并行回归          | 387 + 1959 项通过，0 失败，18 项忽略 | 隔离数据库及 Redis；包含通知事务与索引提交顺序回归                           |
| community 后续事务修复 | 87 项通过                            | 板块权限复用执行器；索引消息提交后发布、回滚不发布                           |
| UI 组件                | 284 项通过                           | 作答保留、结果裁剪、搜索 URL、社区重试、反馈目标、后台刷新及同账号身份刷新   |
| UI 单元                | 281 项通过                           | 域导航、兼容入口与纯逻辑                                                     |
| 类型与 lint            | core / UI 相关检查通过               | 当前变更的静态检查；远程 CI 单独签收                                         |
| 仓库门禁               | 217 项自检通过                       | 边界、迁移、Schema、事件、文档及测试入口等                                   |
| 工作空间 API 旅程      | 2 项通过                             | 最终镜像上的私有教学、多域关系、共享撤销、邀请注册及管理员开户政策           |
| 社区 API 旅程          | 4 项通过                             | core `7d9b3aec`；默认多连接环境发帖、搜索、互动、治理及预审                  |
| 完整浏览器套件         | 22 组、42 步通过，0 失败             | UI `55355081` / core `71ae79ce`；真实 Judge、40 人班级及 LLM Mock，耗时 5m9s |
| 最终预览冒烟           | 两套件通过，无脚本错误               | 最新 core `7d9b3aec`；A+B V2 作答保留、教师登录、作业和矩阵读取              |
| 远程 CI                | `0156bddf` 完整 CI 通过              | 同次 E2E 的社区竞态已定位修复；最终签收以 PR 当前头的完整 CI/E2E 为准        |

core 的最新全量并行记录包含社区和教学通知事务修复，两个分片均通过。测试忽略清单
经标准脚本更新：原搜索环境提前返回改为显式 `ignore`，新增 PostgreSQL
回归只在真实 PG 环境执行；本轮实际启用了对应环境。

补充远程验收发现：`c78ad65b` 的完整 CI 已通过，包含额外性能基准和 WASI
镜像验收； 同次 E2E 的浏览器流程因同账号 `/auth/me` 响应关闭学生抽屉而失败，其他
API E2E 通过。 该竞态在签名提交 `55355081`
修复，新增页面与批注回归在修复前失败、修复后通过。
浏览器用例显式重现同账号资料刷新，最终分支仍须通过新一轮远程门禁。
修复后的本地完整浏览器套件再次通过，显式身份刷新的批注旅程另有 1 组、6 步通过。

`0156bddf` 的完整 CI 和浏览器 E2E 均通过；E2E 中另外 12 个任务也通过，仅社区搜索
失败。根因是 Redis 索引消息在授权事务提交前被消费。`7d9b3aec` 复用现有
`afterCommit` 修复发布顺序，新增两项确定性回归在旧代码失败、修复后通过。
使用最新镜像、开发模式默认多连接池执行社区 API 旅程，4
项全部通过，未手工重建索引。 最终头的 CI/E2E 运行链接与 SHA 在 PR
中签收，历史运行不替代最终头的验证。

## 已核实的真实交互

- 默认域搜索兼容跳转、关键词与类型刷新保留、说明页快捷键保留学校域。
- 真正的 Judge C++ 编译错误、OI 自测输出与最终结果；自测完成后不再被遗留进度
  显示成“评测中”。
- 真正的 OI 比赛代码、客观题从赛时隐藏到结束后开放结果；本人结果自动刷新。
- 教师矩阵在 AC 落库后约 786ms 显示补做成绩；同域权限与撤销受后端检查。
- 私有邀请注册、教师和学生原代码批注、批注修改撤回、新提交隔离、班级归档后读取。
- 两学校预测上传分别得到 50/100
  分；界面题的实际自测、正式评测、历史回滚与跨域草稿。
- 产物 ZIP 通过 Web 上传、检查版本后文件保留、实际 Judge 得到 100 分，
  并通过“查看评测”读取结果；接口受理状态为 201。
- 双标签页额度保存与旧 revision 的 409；输入保留，不因更新而替换旧表单。
- 同一浏览器主套件与恢复套件分别登录；退出恢复套件后主套件仍保持本人身份。
- 1440px 与 390px 长标题、40
  段题面、独立滚动及选项保留：无横向溢出、无脚本错误。

完整套件已经统一通过，定向结果仍单独记录，不扩大到未测范围。单次 786ms 是实际
交互测量，不作为所有负载下的性能保证；LLM 上游使用隔离
Mock，不代表真实付费供应商账单验收。

## 本地 review 与数据边界

- 主套件 `http://127.0.0.1:3003`，core `8104`：保留一个默认域和 A+B。
- 丰富夹具预览 `http://127.0.0.1:3008`，core
  `8107`：独立恢复库，包含教师、学生及各题型。
- 本轮评测、教学与浏览器夹具只写上述独立运行库；单元/并行测试使用另外的隔离库与
  Redis。
- 主套件 reset 前备份与恢复套件的既有备份保留；没有通过重建业务库掩盖迁移问题。
- HTTP 开发预览显式允许非 Secure Cookie，生产 Secure 规则保持。
- 恢复套件浏览器验收时临时使用 Mock 邮件和测试单连接配置；社区 API 验收另用
  开发模式的默认多连接池。结束后已恢复
  `NOJ_ENV=production`、`EMAIL_PROVIDER=disabled`。恢复后教师实际登录、题目、作业和矩阵
  读取均为 200，矩阵页面可用且无脚本错误。

core 镜像源码为签名提交 `7d9b3aec6cecef96ee82ebe3a63897de3841479d`；UI 补充
文件名提示和同账号刷新修复，对应签名提交
`553550818edf44b8fadee62afd8e394e4107e4d7`。
编译时注入提交身份，页脚可核实；文档和测试的后续提交不改变这些镜像的业务源码。

A+B 的稳定题目 ID 为 `ccdded51-bab8-4a73-a20a-34f8e0a620ac`，当前 V2 为
`b60c0684-b61c-4c43-8f3c-9de4f6af9b89`。通过正常草稿、预检、发布流程生成， V1
和原提交没有改写；实际检查版本后代码输入保留，样例 `1 2 → 3` 正确。

## 验证命令与证据

- core：`deno task test:parallel`，使用独立 `noj_ui_fixed_regression` 数据库、
  `test_unit` / `test_db` Schema 和专用 Redis。
- UI：`deno task test`、`deno task test:components`、`deno task lint`、
  `deno task check:types`、`deno task check:types:nuxt`，以及格式检查与生产镜像构建。
- 真实浏览器：`deno task test:domain browser`，显式启用 E2E，指向恢复套件
  `8107 / 3008`；LLM Mock 域名与 Gateway 白名单一致，不放宽 SSRF 规则。
- API：`deno task test:domain cross-domain --filter=workspace`，同一独立恢复套件。
- 社区 API：`deno task test:domain community`，最新 core 镜像与默认多连接池。
- 仓库：`deno run -A scripts/check-ci.ts`，217 项自检通过。
- 本地日志：`/tmp/noj-core-final-search-parallel.log`、`/tmp/noj-ui-community-final-api.log`、
  `/tmp/noj-ui-signed-workspace-api.log`、`/tmp/noj-ui-final-search-root-gates.log`。
- 社区提交顺序回归的失败与成功记录分别为 `/tmp/noj-community-search-red.log`、
  `/tmp/noj-community-search-green.log`；最终预览记录为
  `/tmp/noj-ui-final-main-review.log`、
  `/tmp/noj-ui-restore-preview-smoke.log`。
- 身份刷新修复后的完整浏览器记录为 `/tmp/noj-ui-identity-browser-full.log`，
  显式同账号刷新回归为 `/tmp/noj-ui-identity-browser-regression.log`。
- 已实际查看的截图：`/tmp/noj-ui-final-main-desktop.png`、`/tmp/noj-ui-final-main-mobile.png`，
  以及长题面截图
  `/tmp/noj-ui-review-long-title-desktop.png`、`/tmp/noj-ui-review-long-title-mobile.png`。

## PR、审批与人工事项

[PR #646](https://github.com/Neuro-OJ/neuro-oj/pull/646) 基于原架构
[PR #643](https://github.com/Neuro-OJ/neuro-oj/pull/643)，分支为
`codex/domain-ui-repair`。 按主题保留小提交，全部签名，非平凡变更附 implemented
Agent Note；未直接推送 main，
未绕过一票批准规则。首轮完整远程检查已通过，最终头继续执行
CI，合入前必须全部通过。 本文不构成已合入证明。

人工队列 D01–D04 保持 proposed：历史类型如需转换须根据实际数据决定，账号层与域
业务边界和正式合入仍供用户 review；不会因无人值守自动删除历史或变更审批。
