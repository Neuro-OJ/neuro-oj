# Agent Note: 修复 PR #409 review 发现

Status: implemented

## Problem

PR #409 修复了 E2E 全链路回归，但管理端 LLM gateway 的错误映射只覆盖
Provider 的 POST/PUT，读取与配额入口仍可能返回未处理的 500；同时竞赛排名测试
对空数组的可选链比较会误通过，运行期错误测试也仍接受 `finished + 0`。

## Decision

- 在管理端 LLM 路由统一捕获 gateway 错误；HTTP 5xx 与网络不可用映射为
  `ServiceUnavailableError`，400/404 保留对应业务语义，未知异常继续交给全局处理器。
- 显式检查排名数据存在且分数大于零。
- 运行期错误和语法错误 E2E 严格要求最终状态为 `error`。
- 为错误映射增加纯单元测试，覆盖 400、404、5xx 和未知异常。

## Alternatives considered

- 只在现有 Provider POST/PUT 中补 catch：否决。读取、用量和配额入口仍会把 gateway 失败伪装成 500。
- 将所有未知异常都映射为 503：否决。程序缺陷应保留为未处理错误，避免掩盖内部故障。
- 保留 `finished + 0` 的宽松 E2E 断言：否决。它无法验证运行期错误协议已经收敛为 `error`。

## Consequences

- 管理端 gateway 依赖不可用时返回 503，客户端可区分依赖故障与参数错误。
- 相关 E2E 用例更严格，旧协议或错误状态映射会明确失败。
- 成功响应结构、gateway 内部 API 和数据库结构不变。
