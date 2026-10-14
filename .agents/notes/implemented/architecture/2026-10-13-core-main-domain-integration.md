# Agent Note: 主线新评测能力与 Domain 执行归属整合

Status: implemented

## Problem

Domain 升级开发期间，main 增加了 prediction 文件提交、UI 参数提交、模型别名及
LLM
自测冻结恢复与终态吊销。直接解决文本冲突不足以保留这些能力：旧无域别名解析会使用平台
Provider，新上传分支可能遗漏 Domain 的容量预留，UI
语言判断也可能读取最新版投影而非比赛固定版本。

## Decision

- 模型别名按使用域保存与解析，保留同一次评测只使用一个 Provider
  的约束。题目版本声明能力名称，发布校验语法、预算与网络配置；Provider、真实模型与别名映射在新尝试受理时解析并冻结。
- 保留 v3 token 的域、尝试和版本归属，同时保留 main 的
  `model_map`。重派读取冻结选择，当前 Provider
  必须仍属于使用域且启用。旧管理员入口明确归 main，域内别名管理沿用授权、审计与
  revision 前置条件。
- prediction 与 artifact
  共用既有上传服务，保留各自文件验证和执行类型，同时保留域容量预留、结算、提交绑定和受理事务。执行模式及
  UI Python 模板来自可信作答版本，比赛固定 UI 版本的模板入口返回 404。
- LLM
  自测保留首次凭据、冻结快照恢复及完成、取消、超时后的持久吊销；自测恢复读取记录自身的使用域。
- 新增按本人、使用域与源题分页的自测历史目录。列表只返回元数据与汇总成绩，代码与详情按需读取。在赛选手的同域同题列表和已知旧自测
  ID 详情使用既有练习限制，比赛结束后恢复，其他域不受影响。
- main
  新测试夹具显式建立源域、已发布版本与真实题库绑定；清理按评测记录、绑定、成员角色、成员及账号的外键关系执行。未放宽生产约束或加入隐式默认绑定。

## Alternatives considered

- 仅保留 topic 版本会丢失 main 已发布的
  UI、prediction、别名和自测恢复修复，未采用。
- 仅保留 main 版本会恢复全站 Provider 和无域执行路径，未采用。
- 发布时强制解析部署模型会阻止可移植题包和其他域独立选择模型，未采用。配置未就绪在目标域新尝试受理时明确失败。
- 每条自测列表记录调用完整详情服务会重复加载身份和资源，未采用。列表在一次资源授权后按域、本人、源题定向分页，不返回原始输出或详情。

## Consequences

在隔离集成工作区与数据库验证，未重启正式开发或 E2E 运行栈：

- 标准 submission 域测试：PostgreSQL 412 passed / 0 failed / 10 ignored；PGlite
  381 passed / 0 failed / 41 ignored。
- 标准 contest 域测试：PostgreSQL 117 passed / 0 failed；PGlite 116 passed / 0
  failed / 1 ignored。
- 标准 gateway 域测试：PostgreSQL、PGlite 各 39 passed / 0 failed。
- 标准 admin 域按 `admin gateway` 过滤：两库各 9 passed / 0 failed，其他 14
  项未执行。
- 新组合回归验证两个学校对同一共享 UI 题使用不同域别名与真实模型、token
  域及尝试归属、排队后配置变化不改写冻结模型、UI 自测使用域归属、prediction
  对象真实字节与执行归属。HTTP
  验证自测列表跨域与账号隔离、旧记录赛时限制、赛后恢复及其他域不扩散。
- 使用真实数据库和本地临时对象存储；Redis 协议与 Gateway HTTP
  在组合服务测试中使用隔离替身，未将其称为 Judge 全链路验收。
- 受影响文件格式、lint、类型检查及域边界检查通过。历史迁移整合、全量集成回归与运行栈验收由主
  agent 分别记录，本记录不代替那些完成条件。

日志保存在本机
`/tmp/noj-integration-submission-{pg,pglite}-final.log`、`/tmp/noj-integration-contest-{pg-second,pglite-first}.log`、`/tmp/noj-integration-gateway-{pg,pglite}-final2.log`
与 `/tmp/noj-integration-admin-alias-{pg,pglite}-final.log`，不提交临时日志。
