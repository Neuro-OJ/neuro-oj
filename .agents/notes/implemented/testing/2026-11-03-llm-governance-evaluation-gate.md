# Agent Note: LLM 治理用例的显式评测屏障

Status: implemented

## Problem

LLM 治理 Browser 用例需要在「评测尝试仍在途」的确定状态下经 UI 修改模型别名，
再验证原尝试使用冻结快照。旧 evaluator 在真实 `llm.complete()` 前固定
`time.sleep(20)`，两轮引入约 40 秒等待；等待窗口与 UI 操作速度无关，慢机器会
出现尝试已结束、断言失效。

## Decision

- 新增 `scripts/e2e/test_coordinator.py`：Python 标准库 `ThreadingHTTPServer` +
  条件变量，支持并发等待与释放。接口为 `POST /gates`、`GET /gates/<id>`、
  `GET /gates/<id>/wait?arrival=<nonce>`、`POST /gates/<id>/release`、
  `DELETE /gates/<id>`、`GET /health`；重复 gate 409、相同 nonce 不重复计数、
  release 幂等、DELETE 唤醒并清理。
- `noj-tests/fixtures/evaluation-gate.ts` 区分主机管理 URL（loopback）与
  evaluator 内部 URL（容器网络），等待上限 45 秒（短于 evaluator 60
  秒时限），缺失 gate、 超时、取消分别产生明确错误。
- evaluator 脚本在真实 `llm.complete()` 前阻塞在 gate；测试只等待一个 evaluator
  到达（兼容 Judge 并发 1），确认两条尝试仍在 queued/judging 后改模型别名，再
  释放 gate 并等待两次真实评测完成。
- Compose 只把协调服务接入 `noj-eval-net`，主机端口绑定 loopback；action.yml
  增加协调服务健康等待、契约检查与日志收集。

## Alternatives considered

- 保留固定 sleep：与 UI 速度无关，慢机器不稳定，也无法证明尝试在途。
- 轮询数据库直到出现 queued 尝试：只证明已受理，不证明 evaluator 已到达
  `llm.complete()` 前一刻，仍可能在改模型前完成。
- 使用单线程 `HTTPServer`：等待请求会阻塞 release 请求，必然死锁。
- 用数据库行锁模拟屏障：需要生产代码提供测试专用锁，超出测试基础设施范围。

## Consequences

- 真实 E2E 栈上 9 步用例 19 秒通过，两轮固定 40 秒休眠被消除；冻结快照、
  域归属、用量与 Mock 上游模型断言全部保留。
- 协调服务缺失、gate 不存在、等待超时、DELETE 取消都会让用例失败而非跳过。
- 只等一个 evaluator 是刻意选择：等待两个在 Judge 并发 1 时会死锁。
- 每次运行创建一个带提交的 canary/治理题，E2E 临时库可接受；长期库需要清理策略。
