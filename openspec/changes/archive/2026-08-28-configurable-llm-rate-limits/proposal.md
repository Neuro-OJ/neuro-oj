## Why

noj-llm-gateway 当前将用户和 IP 的分钟限流值固定为每分钟 60 次，无法适配不同部署规模、上游 Provider 额度和运营策略。将两个维度独立配置，同时保留默认值，可在不改变既有部署行为的前提下完成生产调优。

## What Changes

- 新增用户分钟限流配置 `NOJ_LLM_USER_RATE_LIMIT_PER_MINUTE`，默认值为 `60`。
- 新增 IP 分钟限流配置 `NOJ_LLM_IP_RATE_LIMIT_PER_MINUTE`，默认值为 `60`。
- 网关启动时校验两个配置为正整数，并将配置传递给 Redis Lua 限流脚本。
- 增加配置解析、默认值和限流参数传递测试。
- 更新网关环境变量模板、生产环境变量模板及运营文档。
- 不改变提交级、用户/题目/全局日/月调用量、Token 和费用配额逻辑，也不新增响应头或后台动态配置。

## Capabilities

### New Capabilities

- `llm-gateway-rate-limits`: 配置并执行用户/IP 分钟限流。

### Modified Capabilities

<!-- 无。 -->

## Impact

影响 `noj-llm-gateway` 的配置解析、限流服务和测试，以及根目录生产环境变量模板和运营部署文档。不引入依赖，不改变外部 API 格式。
