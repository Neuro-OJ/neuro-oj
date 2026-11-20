# Agent Note: Core 受管后台任务与关闭排空

Status: implemented

## Problem

消费者、周期任务和 SSE 的停止方式不统一。P2a 草稿吞掉完成错误，超时后仍宣称关闭成功并切断数据库；SSE 初次订阅被误当作任务结束，事件回调中的异步授权查询也未被排空。

## Decision

- 所有 Core 后台组件采用 `ManagedTask { name, stop, done }`；装配层统一登记，逆序停止并等待全部 settle 后汇总原始错误。
- 同步停止 HTTP 接收与任务领取，关闭活跃 SSE，再等待 HTTP、后台及流内 setup/异步事件全部收尾，最后关闭 Redis/DB。失败非零退出；超时有意跳过依赖关闭，避免切断在途工作。
- 周期任务不重叠，等待本轮及异步错误处理；单例完成后才释放。消费者关闭等待可注销，不累积长期 Promise 回调；停止竞争窗口中的消息保留 processing 供恢复，在途处理和确认仍等待完成。
- Pub/Sub 订阅按连接代次校验，关闭等待真实连接及订阅收尾。DB/Redis 关闭失败传播给协调器；兼容 ioredis 同步 void 的 disconnect。
- Core 显式向应用注入 SSE scope，全部 SSE 路由使用公共骨架，权限查询和事件发送进入 `ctx.run`；清理全部退订、心跳、超时和指标。
- `deno task test:runtime` 不加载事务 preload，采用 fake、受控 Promise 与真实随机端口 HTTP 验收。数据库集成使用规定测试入口、本轮独立 PostgreSQL/Redis 和临时存储目录。

## Alternatives considered

- 各任务保留独立关闭惯例：装配层仍可能漏停、漏等，拒绝采用。
- 超时继续关闭依赖并以 0 退出：掩盖未完成写入，拒绝采用。
- 仅测 fake HTTP：无法证明真实长连接排空，测试保留 loopback 端点且权限不足直接失败。
- 只等待 SSE setup：无法覆盖随后事件中的数据库授权查询，必须追踪在途事件。

## Consequences

关闭失败和超时可诊断；截止后连接由进程退出回收。任务/连接句柄只属于本进程，多副本约束已登记，不承载业务事实。消息至少一次处理、比赛冻结与授权、成绩语义保持既有规则，未执行生产切换。

本记录仅覆盖 P2a。P2b 的生产启动禁 DDL、移除 PGlite/手写 DDL/测试事务代理和真实 PostgreSQL 启动器继续按批准计划实施。验收结果见计划跟踪清单。
