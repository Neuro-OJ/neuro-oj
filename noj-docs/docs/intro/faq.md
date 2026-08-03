# 常见问题（FAQ）

按角色整理的常见问题。找不到答案时，可查阅[术语表](../reference/glossary.md)与[结果状态](../reference/result-status.md)。

## 做题人

### 登录提示「用户名或密码错误」，但我确定密码没错？

系统不会区分「账号不存在」与「密码错误」，这是防枚举设计。请确认使用的是用户名还是邮箱；连续失败会触发限流与退避，等待一段时间再重试。忘记密码请走[密码重置](../users/account.md#forgot-password)流程。

### 密码有什么要求？

至少 12 位，必须同时包含小写字母、大写字母和数字；不能与用户名相同，也不能与邮箱前缀相同。

### 为什么我签到时说「今天已签到」？

签到按 **UTC 日期**统计。北京时间 0:00–8:00 属于前一个 UTC 日，可能与你本地日期不一致。签到没有积分，只有连续天数记录。

### 提交一直显示排队中？

评测队列繁忙或 Judge Worker 不在线。可以在「评测队列」页面观察队列长度；若长时间无进展，请联系运营者（见[运营者 FAQ](#operators)）。

### 我的代码和输出别人能看到吗？

不能。代码、标准输出与用例级详情仅**提交者本人和管理员**可见；其他用户只能看到状态、得分、用时与内存。

### 我删掉了一条私信，对方还能看到吗？

能。私信删除是**按用户软删除**——只对你隐藏，对方仍然保留。

### 我选了 C++ / C / JavaScript 提交，为什么无法评测？

当前评测运行时仅完整支持 Python（多语言评测为项目的决策性不做项）。`cpp` / `c` / `javascript` 是提交接口预留的语言标识，尚无评测运行时，请使用 Python 提交。

## 运营者 {#operators}

### 启动报 `JWT_SECRET 长度不足`？

`JWT_SECRET` 至少 32 字符，使用随机串生成：`openssl rand -base64 48`，并写入 `noj-core/.env`。

### 提交后长时间 Pending？

确认 noj-judge 已启动、连接的 Redis 与 noj-core 一致。查看队列积压：`redis-cli LLEN noj:judge:queue`。常见原因与扩容方法见 [Judge Worker 运维](../operators/judge-workers.md#queue-monitoring)。

### 评测镜像不存在？

先执行 `noj-judge/scripts/build-sdk-images.sh` 构建 `noj-evaluator-python` 与 `noj-solution-python`，确认 noj-core 的评测镜像白名单已登记，再重启 Judge Worker。

### 大量 SystemError？

通常是纯净评测包、运行时配置、镜像、协议或 evaluator 异常，需要查看 Judge Worker 日志：`RUST_LOG=noj_judge=debug`。也检查题目支持包是否完整（`deno task problems:build` 重建）。

### 限流把所有请求都拦了？

如果部署了反向代理，必须在 noj-core 配置 `TRUSTED_PROXIES`（生产环境 `Neuro OJ_ENV=production` 强制要求），否则所有请求都来自代理 IP，会被当成同一来源限流。

## 出题人

### 上传支持包提示格式错误？

统一题目包必须是 `.zip` 格式且 Content-Type 合法。请用「上传」而非压缩软件的特殊格式；包结构与 manifest 要求见[统一题目包](../problemsetters/support-package.md)。

### 题目编辑器中看不到语言选项？

题目的可选语言由运行时配置决定；且当前仅 Python 有完整评测运行时。

### 上传后修改不生效？

上传按 manifest 的 `(type, number)` 匹配：命中既有题目则更新，未命中则新建。检查 manifest 中的 `type` / `number` 是否与目标题目一致。修改题目配置后，可对旧提交触发 rejudge 重新评测。

### 用户提交出现 FunctionNotFound？

题面声明的函数名与 evaluator 实际调用的函数名不一致，或用户代码模块无法导入。检查 evaluator 的调用名与题面示例是否一致。
