## ADDED Requirements

### Requirement: 评测并发上限

每个 noj-judge 实例 SHALL 限制同时执行的评测任务数量。该上限 SHALL 通过 `JUDGE_MAX_CONCURRENT_JUDGES` 环境变量配置；变量缺失、为零或不是正整数时 MUST 使用安全的有限默认值。任务拉取不得无限制地将 Redis backlog 转换为已启动的 Docker 评测任务。

#### Scenario: 达到并发上限后暂停拉取

- **WHEN** 当前已有的评测任务数量达到该实例的并发上限
- **THEN** judge 不再拉取新的评测任务，直到已有任务完成或被终止

#### Scenario: 任务完成后释放并发额度

- **WHEN** 一个评测任务完成、失败或被优雅关闭流程回收
- **THEN** 该任务释放并发额度，后续任务可以继续被拉取

#### Scenario: 默认配置保持有限并发

- **WHEN** 未配置 `JUDGE_MAX_CONCURRENT_JUDGES` 或配置无效值
- **THEN** judge 使用大于零且有限的默认并发上限，并正常启动

#### Scenario: 优雅关闭等待受限任务

- **WHEN** judge 收到关闭信号且仍有评测任务运行
- **THEN** judge 仅等待当前受并发上限约束的 in-flight 任务，并按既有 drain 超时策略退出
