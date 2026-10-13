# Agent Note: 最终产物的真实 API 验收与隔离执行目标

Status: implemented

## Problem

用户要求 CI 全部通过并以 API 验收。浏览器和服务单元不能代替最终产物的 REST
请求、评测与持久进度；多套栈并存时，固定 MQ 容器可能写入旧环境。

## Decision

使用独立 `noj-main-integration-20261013` 最新正式 core，明确 API、数据库、
Judge／Gateway／Redis／MinIO 目标，调用标准 E2E 任务，不写假成绩或用量。 MQ
用例支持验收环境指定容器、DB、认证，标准 CI 默认容器及 DB 1 不变；本地
明确独立容器 DB 0，失败继续抛出，没有增加跳过或降级。

## Alternatives considered

- 浏览器通过代替 API：无法提供完整 REST 和后台处理依据。
- 在旧 Redis 容器注入消息：破坏既有环境，不采用。
- 忽略缺环境的测试：需要实际验收，提供真实依赖后执行。

## Consequences

- submission 完整 38 项通过，八项 S3 条件忽略；随后开启真实 S3，八项实际
  全部通过，覆盖该模块全部 46 项，0 失败。
- cross-domain 完整 55 项、10 步、零失败、零忽略，61 秒。五题型作业、两学校
  模型／用量、学生／教师隔离、共享撤销、旧入口、网络与 S3 故障实际执行。
- 40×5 两任务由 API 发布，OI／AI／LLM／产物／客观题实际评测自动计入；截止 后 OI
  100 分仅更新补做，按时 60 分保留，学生矩阵／同学代码／Provider 被拒。
- 正常后台进度 1109ms；core 实际重启，两个持久积压事件 2218ms 恢复，Judge 和
  Gateway 不重启，不依赖读取接口修补投影。
- 预测夹具取消旧 P 分类后，真实上传、6666 分与三隐藏点两项补验通过。 正式恢复栈
  CLI HTTP push 与最终 UI 历史读取另外通过。

日志在 `/tmp/noj-root-api-submission-full-final.log`、
`/tmp/noj-root-api-s3-support-final-second.log`、
`/tmp/noj-root-api-cross-domain-release-final.log`。首次 S3 filter
拼错是零通过、 46 filtered，不计验收；纠正后确实执行八项。

最后提交的远端 CI／各 API job 仍独立跟踪，不提前称全部通过。业务源码没有因
验收新增兜底，原开发与旧验收栈未被改写。
