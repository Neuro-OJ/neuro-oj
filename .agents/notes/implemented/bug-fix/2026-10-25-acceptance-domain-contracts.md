# Agent Note: 整栈验收中的邀请注册与 Provider 隔离合同

Status: implemented

## Problem

邀请预览的布尔优先级阻止 invite 模式的合法域邀请注册；两套兼容入口的政策可能漂移。
Gateway 将他域 Provider 与本域停用混为同一状态，Core 又将停用错误冒泡为 500。
客观题比赛交卷比较公开编号和内部 UUID，组件测试桩缺少 useAsyncData 的上下文参数。

## Decision

两个邀请入口共用纯政策函数，覆盖三种注册模式、角色及全局开关组合。
Provider 他域与不存在统一 404，本域停用为 400；Core 仅转换明确的 400/404 Provider 业务错误。
客观题在 admission 比较前统一比赛 ID，继续使用授权快照执行交卷。组件测试桩传入框架上下文。
所有修复追加于现有 stack 顶端；本次所有者明确接受不签名提交，旧签名提交保持原样。

## Alternatives considered

不删除仍有导出调用的旧邀请服务，也不复制第三份政策。不把所有 Gateway 错误转成 400。
不修改原 stack 历史或降低组件业务断言。

## Consequences

admin_only、关闭注册和邮件不可用仍阻止邀请开户；测试明确校验外域资源不可枚举。
已有验收日志只作为历史证据，最终验收仍须在修复与 main 整合后的候选提交执行。
