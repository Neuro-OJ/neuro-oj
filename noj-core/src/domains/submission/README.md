# submission

提交、评测尝试、自测、批量任务与 Judge 协议的业务模块。跨模块调用使用 `index.ts`
门面，测试使用 `deno task test:domain submission`。

## 使用域执行入口

`createDomainSubmission`、`createDomainArtifactSubmission` 和
`createDomainSelfTest` 从使用域 slug 与来源题号解析稳定源题 ID、题库绑定和当前
作答版本。客观题交卷由 objective 模块的 `submitDomainObjectivePaper` 复用同一
域执行检查。提交与自测使用原存储、评测任务与正式判定链，不复制源题字节。

外部准备之后，入库事务重新授权并检查客户端作答版本；按域 ID 顺序锁使用域与
源域，再锁源题和绑定，阻止共享撤销、下架或策略变更与受理交错。客户端不提供
可覆盖使用域或绑定的字段。比赛中的同域选手不能从练习、自测或教学入口重评赛题。

准备路由提供：

- `POST /domains/:slug/submissions`：JSON 代码或 multipart 产物，定位字段为
  `problem_ref`，引用题使用来源域题号，例如 `main:1001`。
- `POST /domains/:slug/problems/:reference/self-tests`：独立自测。
- 客观题准备路由位于 objective，路径为
  `POST /domains/:slug/problems/:reference/objective-submissions`。

所有新请求明确提供 `version_id`。当前入口使用使用域默认作答版本，版本变化返回
冲突，不改写客户端代码或答案。旧默认域提交列表、详情、队列状态与客观题读取
排除其他域记录；这不代表所有统计、搜索、SSE 和批量执行已经完成隔离。

这些路由尚未在组合根开放。完整域查询、教学／比赛上下文、批量执行、域内 LLM
和存储／提交频率配额继续接入。新域的 LLM 调用在执行链就绪前明确拒绝，不能
回退到默认域 Provider。真实
Judge、完整浏览器旅程及最终隔离验收继续按升级清单执行。
