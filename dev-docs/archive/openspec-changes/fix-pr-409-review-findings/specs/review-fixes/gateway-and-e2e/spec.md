## Purpose

保证管理端 LLM gateway 失败、评测运行期错误和竞赛排名测试都以明确且可验证的状态呈现，避免错误响应或测试断言掩盖真实故障。

## ADDED Requirements

### Requirement: 管理端 gateway 失败必须返回明确的客户端错误

管理端所有调用 LLM gateway 的路由在收到可识别的 gateway 非 2xx 响应时 MUST 返回对应的可读 4xx 错误；gateway 不可连接时 MUST 返回服务不可用错误，而不是未处理的 500。

#### Scenario: Provider 查询 gateway 返回错误

- **WHEN** Provider 列表或用量/配额查询收到 gateway 非 2xx 响应
- **THEN** 管理端响应为可读的 4xx 或服务不可用状态，且不返回 `INTERNAL_ERROR`

#### Scenario: Provider 写入 gateway 不可用

- **WHEN** 创建或更新 Provider 时 gateway 无法连接
- **THEN** 管理端返回服务不可用错误，而不是未处理异常导致的 500

### Requirement: 评测脚本运行期错误必须产生 error 结果

当样例评测脚本调用用户解答发生运行期错误时，评测脚本 MUST 让 judge 生成 `status=error` 的结果，不得生成 `finished` 结果。

#### Scenario: 用户解答抛出运行期异常

- **WHEN** P1001 的用户解答在调用期间抛出运行期异常
- **THEN** submission 的最终状态为 `error`

### Requirement: E2E 排名和错误断言不得接受缺失数据

竞赛排名 E2E MUST 将空排名或无正分排名判定为失败；运行期错误 E2E MUST 严格验证最终状态为 `error`。

#### Scenario: running 竞赛返回空排名

- **WHEN** 参赛者或管理员排名响应为 200 但数据为空
- **THEN** E2E 用例失败

#### Scenario: 运行期错误状态错误

- **WHEN** 运行期错误 submission 返回 `finished`（即使分数为 0）
- **THEN** E2E 用例失败
