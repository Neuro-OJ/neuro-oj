# 如何提供受限网络能力

本页面向出题人：当题目需要访问外部网络 API（LLM 接口、检索服务等）时，
如何通过 capability 安全地把网络能力交给 solution 使用。

## 三步概览

1. **在题目配置中开启 evaluator 联网**：`runtime_config.evaluator.network.enabled = true`（Web 编辑器勾选「允许 Evaluator 联网」；**有题目创建权限的用户均可开启**——U 型任意注册用户，P 型仅管理员）。开启后 evaluator 容器以 Docker bridge 模式联网；solution 容器**始终无网**。
2. **在 evaluate.py 中注册 capability**：用 `register_capability` 暴露一个**精确封装**的函数。
3. **在题面中声明 capability**：明确写出名称、参数、返回值语义，做题人用 `call_capability` 调用。

::: tip LLM 调用题请优先使用 noj-llm-gateway
如果外部 API 是 OpenAI 兼容的 LLM 服务，**不要**在 evaluator 里保存上游 API Key，
而是使用系统提供的 `noj-llm-gateway`（`llm.complete`）。这样真实 Key 只存在于
gateway，并且自动获得 eval_token、限流/额度与用量审计。具体接入见
[出 LLM 调用题](llm-problem.md)。
:::

## 注册 capability

```python
from noj_evaluator_sdk import register_capability, result

def request_llm_completion(prompt: str) -> str:
    # ... 调用外部 LLM API（evaluator 已联网）
    return completion_text

register_capability("request_llm_completion", request_llm_completion)
```

- handler 是普通 Python 函数，在 evaluator 容器内执行，拥有该容器的网络能力。
- 参数/返回值受 [RPC 类型约束](rpc.md)（`None / bool / int / float / str / bytes / list / dict`）。
- 重复注册同名 capability 时，最近一次生效。
- handler 抛异常时，错误帧（`code=Exception` + trace）会返回给 solution。

## 核心原则：封装精确函数，而不是通用转发

**这是最重要的安全边界。** capability 是 solution 调用网络**唯一**的入口，
它的签名就是你的安全策略。请封装"业务意图"，而不是"网络能力"：

::: danger 反例：通用转发（会打开 SSRF 面）
```python
def fetch_url(url: str) -> bytes:
    # 任何 solution 代码都能请求任意地址：
    # - http://169.254.169.254/... （云元数据服务，可能泄露凭据）
    # - http://<内网>/...           （评测内网、judge 宿主机服务）
    # - 任意公网地址（把评测服务器变成攻击跳板）
    return urllib.request.urlopen(url).read()

register_capability("fetch_url", fetch_url)
```
:::

::: tip 推荐：封装业务意图
```python
def request_llm_completion(prompt: str) -> str:
    """只允许调用固定的 LLM API，prompt 是唯一输入。"""
    # URL 固定、方法固定、域名固定——solution 无法控制目标地址
    payload = {"model": "gpt-4o-mini", "messages": [{"role": "user", "content": prompt}]}
    resp = urllib.request.urlopen(
        urllib.request.Request(
            "https://api.example-llm.com/v1/chat/completions",
            data=json.dumps(payload).encode(),
            headers={"Authorization": "Bearer " + os.environ["LLM_API_KEY"]},
        ),
        timeout=10,
    )
    return json.loads(resp.read())["choices"][0]["message"]["content"]

register_capability("request_llm_completion", request_llm_completion)
```
:::

**判断标准**：solution 通过你的 capability 最多能做到什么？如果"任意目标地址、任意方法、任意头"都能被控制，就等同于给 solution 开了全量网络。目标地址应当固定或来自受控枚举，而不是由调用方自由传入。

## 安全清单（出题人自查）

- [ ] capability 名称与签名精确表达业务意图，**不暴露通用 HTTP 转发**
- [ ] 目标 URL/域名固定（或来自白名单枚举），不由调用方任意指定
- [ ] 若确需调用方传 URL，校验：仅允许 `https://`、拒绝 IP 字面量、拒绝内网/链路本地地址段（`10.x`、`172.16-31.x`、`192.168.x`、`169.254.x`、`127.x`、`0.0.0.0`、IPv6 对应段）、**跟随重定向前再校验一次目标**
- [ ] 绝不访问云元数据服务（`169.254.169.254` / `fd00:ec2::254`）
- [ ] 网络请求设置超时（如 `timeout=10`），不要无限阻塞
- [ ] API 密钥放在 evaluator 镜像环境变量中，**不放进支持包或题面**；若是 LLM 调用题，密钥应只存在于 `noj-llm-gateway`，evaluator 不持有上游 Key
- [ ] 题面明确声明 capability 名称、参数、返回值与限制

## 常见陷阱

- **handler 内嵌套双向调用会死锁**：capability 在 evaluator 的 runner reader 线程中同步执行，handler 内再调用 `runner.call()`（回调 solution）会互相等待，只能等评测总超时兜底——**不要**在 handler 里嵌套调用 solution。
- **重定向绕过**：请求 `https://safe.example.com` 被 302 到 `http://169.254.169.254/`。跟随重定向的库默认会跳转——每跳都要重新校验目标。
- **DNS rebinding**：域名先解析到公网 IP 通过校验，随后解析到内网 IP。固定域名 + 服务端解析并校验实际 IP 可缓解。
- **编码/别名绕过**：`http://127.0.0.1`、`http://2130706433`（十进制 IP）、`http://[::1]` 等写法都需要覆盖。
- **secret 泄露**：把 `Authorization` 头、API key 写进 capability 参数或题面，会被任何提交者看到。普通网络能力中密钥必须留在 evaluator 侧；LLM 调用题则通过 `noj-llm-gateway` 托管，evaluator 不接触上游 Key。

## 网络模式说明

- `network.enabled = true`：evaluator 以 Docker **默认 bridge** 联网（**全量**出网，无网络层白名单）。安全依赖上述 capability 设计原则。
- `network.enabled` 缺省 / `false`：evaluator 与 solution 均无网（默认，与旧行为一致）。
- **横向移动面（威胁模型）**：Docker 默认 bridge 允许容器间互通（ICC），联网的 evaluator 可探测同宿主其他容器及网关（`172.17.0.1` 等）上的服务。由于 evaluator 只运行出题人编写的可信代码，此面由"不要注册通用转发 capability"约束兜底；生产加固方向（每任务独立 user-defined network + `icc=false`）已列入规划，当前版本请以 capability 封装为准。
- **未来增强**：网络层白名单代理（egress proxy）已列入规划，届时可在网络层兜底限制域名/端口；当前版本请以 capability 封装为准。

## 验证方法

- 本地用 `deno task dev-setup` 环境跑一次真实提交，确认 solution 能通过 `call_capability` 拿到正确结果。
- 提交一个恶意尝试（如调用未注册 capability、传非预期参数）确认被拒绝（`CapabilityNotFoundError` / `CapabilityRejectedError`）。
- 如需确认 solution 确实无网，可在题面声明"不允许直接网络请求"，观察提交是否会失败。
