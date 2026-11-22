# Agent Note: P3 assets 与 platform 所有权迁移

Status: implemented

## Problem

对象存储 registry、上传预约、引用保护与域容量计量散落在旧 system/workspace
服务；系统设置、公告、轮播、JudgeImages、法律数据请求与法律同意也没有稳定的
platform 业务边界。旧入口还把请求身份和审计上下文隐含在 RequestContext 中，存储
原子 helper
则允许根连接与事务句柄混用，容易在跨业务写入时误开嵌套事务或遗漏副作用。

## Decision

1. 将对象存储 transport、registry/reference/reservation/delivery
   与域容量服务归入 `modules/assets`，公开窄门面只暴露业务合同、URL
   解析合同和必填 `DbTx` 原子入口。 旧 system/workspace
   路径保留显式符号适配器；生产门面不导出 provider 工厂、测试 reset 或后台
   reconciliation。
2. 将 system settings、instance/resource
   policy、announcement、carousel、JudgeImages 和 legal services 归入
   `modules/platform`，JudgeImage 类型独立放在 platform types， 避免 platform
   service 运行时反向依赖 problems。公告与轮播的新写接口显式接收
   `UserActor`、scope 和审计元数据；system settings、instance settings、法律文档/
   请求/同意以及 JudgeImage 写接口也要求显式 `UserActor`。旧 HTTP/test
   门面只在迁移兼容路径适配字符串身份，已迁移的 HTTP 组合层直接绑定认证 actor。
3. storage registry/quota 增加 `reserve/grow/settle/release/attach/delete` 等
   `*Tx` 合同，并在兼容入口中识别真实 `DbRoot` 或
   `DbTx`，避免把事务再次包在事务内。对象 不存在与 provider
   无法确认继续分开处理，引用存在时不物理删除。
4. 保留现有物理表、状态机、历史迁移和 lock；`domain_resource_counters` 仍归
   access， assets quota 当前只保留既有计数事实写入，后续由 access 提供窄 Tx
   capability，不在 本轮重定表所有权。

## Alternatives considered

- 只移动文件并继续从旧 service 直接导出：无法改变真实生产依赖图，也会让大范围
  `export *` 掩盖门面边界，因此改为新模块窄门面加旧路径显式适配器。
- 在 assets 中复制或重建计数器表：会破坏 access
  对多资源计数的锁序和共享事实，改为 保留表与现有状态机，等待 access
  的窄事务接口。
- 让 platform service 继续读取 Hono/ALS
  身份：会把授权判断隐藏在业务服务；新接口要求
  `UserActor`，仅旧路径保留兼容适配。
- 把 JudgeImage 类型继续放在 problems：会形成 platform → problems
  的运行时环，改为 platform-owned type contract。

## Consequences

- 新调用方可从 `modules/assets/index.ts` 与 `modules/platform/index.ts`
  消费稳定业务 合同；旧 imports 在迁移期保持可编译且不再通过 storage-quota
  的通配导出扩大公共面。
- 启动 seed/drain 与跨业务写入的最终 application/bootstrap/runtime composition
  仍由 后续阶段收口；本轮没有修改 root metadata、launcher、CI、迁移 journal
  或物理锁。
- 隔离验证覆盖 storage reference protection、missing/unavailable provider、quota
  reservation/rollback、settings reload、legal state machine、platform content
  scope 与 actor 适配；registry/quota/concurrency 测试已迁入
  `modules/assets/tests`，system/legal/instance platform 测试已迁入
  `modules/platform/tests`。隔离运行得到 assets `37 passed / 0 failed`、platform
  `265 passed / 0 failed`。此外已通过相关模块 `deno fmt`、`deno lint` 与入口
  `deno check`。
- 迁移期旧 carousel/announcement 直调无 context 时使用专用 compat
  actor，以保留历史 service/test 行为；这不是生产授权来源，后续应随旧 callers
  完成迁移而删除。
- 边界诊断仍保留一项预期迁移项：`modules/assets/storage/factory.ts` 读取
  platform settings；storage provider factory 属 runtime 基础设施，待 runtime
  composition 根目录建立后移出 assets。本轮未以重新归属业务表或动态 import
  掩盖该依赖。
