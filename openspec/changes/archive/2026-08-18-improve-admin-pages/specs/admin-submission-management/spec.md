## ADDED Requirements

### Requirement: 提交列表进行中状态自动更新

系统 SHALL 在提交管理页面存在 pending 或 judging 状态的提交时自动轮询刷新列表，全部提交进入终态（finished / error）后 SHALL 停止轮询。

#### Scenario: 提交列表自动刷新

- **WHEN** 管理员停留在提交管理页面且列表存在 pending 或 judging 状态的提交
- **THEN** 系统周期性重新请求提交列表，进行中提交的状态随时间更新

#### Scenario: 全部终态停止轮询

- **WHEN** 列表内所有提交均处于 finished 或 error 终态
- **THEN** 系统停止自动轮询，不再发起列表请求

#### Scenario: 重测后恢复轮询

- **WHEN** 管理员对已终态的提交发起重测，列表重新出现 pending 状态
- **THEN** 系统恢复自动轮询直到再次全部终态
