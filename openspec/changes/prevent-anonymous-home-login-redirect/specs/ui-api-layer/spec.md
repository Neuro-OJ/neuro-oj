## MODIFIED Requirements

### Requirement: 静默与自定义错误处理选项

`useApi` SHALL 支持 `silent`、`onError` 与 `redirectOnUnauthorized` 选项：`silent: true` 时不弹 toast（错误仍抛出）；提供 `onError` 回调时用回调替换默认 toast（不重复弹窗）；`silent` 与 `onError` 同时给出时 `silent` 优先；`redirectOnUnauthorized: false` 时，401 错误 SHALL 不触发登录页跳转，但仍 SHALL 原样抛出供调用方处理。默认情况下，非认证页面中的 401 请求 SHALL 保持统一跳转登录页行为。

#### Scenario: 轮询静默

- **WHEN** 轮询请求失败且调用方传 `silent: true`
- **THEN** 不弹 toast，错误照常抛出由调用方处理

#### Scenario: 自定义错误处理

- **WHEN** 调用方传 `onError(err)` 回调
- **THEN** 执行回调且不再自动弹 toast

#### Scenario: 静默优先

- **WHEN** 调用方同时传 `silent: true` 与 `onError`
- **THEN** 不弹 toast，`onError` 仍被执行

#### Scenario: 可选认证后台请求收到 401

- **WHEN** 后台状态探测请求传入 `redirectOnUnauthorized: false` 且服务端返回 401
- **THEN** 不跳转登录页，错误仍被抛出并由调用方静默处理

#### Scenario: 默认认证失败跳转

- **WHEN** 非认证页面的业务请求未传 `redirectOnUnauthorized: false` 且服务端返回 401
- **THEN** 清除本地登录态并跳转登录页，同时保留当前页面作为回跳地址
