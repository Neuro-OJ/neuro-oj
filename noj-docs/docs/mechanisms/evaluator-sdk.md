# Evaluator SDK 规范手册

Evaluator SDK（`noj_evaluator_sdk`）是运行在出题人 **Evaluator 评测裁判容器**
中的核心基础库。它负责建立与选手容器的 RPC
进程管道、执行强类型函数调用与超时熔断、提供反向能力代理（Capability），并按统一协议写出最终成绩与用例诊断详情。

---

## 模块导入与快速概览

```python
from noj_evaluator_sdk import (
    # 核心调用控制器
    SolutionRunner,
    # 异常错误类族
    NotFoundError,
    RejectedError,
    SolutionTimeoutError,
    SystemError,
    ConnectionError,
    # 能力注册与结果上报
    register_capability,
    result,
    # 大模型调用辅助模块
    llm,
)
```

---

## 调用选手解答（`SolutionRunner`）

### 1. 基础调用与实例创建

在 `evaluate.py` 中初始化 `SolutionRunner` 实例即可发起 RPC 请求：

```python
runner = SolutionRunner()

# 发起远程函数调用
try:
    actual = runner.call("solve", 10, 20)
except NotFoundError:
    result.wrong_answer(score=0, details={"error": "未定义 solve 函数"})
```

### 2. 调用级独立超时设置（`timeout_ms`）

`runner.call()`
支持显式指定当前单次调用的超时时间（毫秒）。当处理测试点梯度较大（如小用例
100ms，大用例 5000ms）时尤为实用：

```python
# 缺省时回退到题目级别的 call_timeout_ms
ans1 = runner.call("solve", 1, 2)

# 为复杂大用例显式分配 3000ms 独立超时配额
ans2 = runner.call("solve", big_graph, timeout_ms=3000)
```

::: warning `timeout_ms` 参数契约
`timeout_ms` 必须为**正整数**或 `None`。传递 `0`、负数或非整数将立即抛出 `ValueError`。若单次调用发生超时，SDK 抛出 `SolutionTimeoutError`：

- **正确做法**：出题人应使用 `try...except SolutionTimeoutError` 捕获该异常，标记当前测试点超时，并给 0 分继续评测后续用例；
- **严重后果**：若未捕获该异常，评测脚本将在没有写出 `---RESULT---` 的情况下中途溃退，评测终态将被系统判定为系统级 **`error`**。
:::

---

## 异常模型与防御性捕获

`runner.call()` 根据选手沙箱底层回传的状态码，结构化映射为以下 Python 异常：

| 异常类型                   | 对应协议状态码              | 产生诱因与处理准则                                               |
| -------------------------- | --------------------------- | ---------------------------------------------------------------- |
| **`NotFoundError`**        | `NotFound`                  | 选手代码未声明该顶层函数。通常直接判定该用例 0 分                |
| **`RejectedError`**        | `Rejected`                  | 参数/返回值不符合类型白名单，或序列化后单帧体量 > 1 MiB          |
| **`SolutionTimeoutError`** | `CallTimeout`               | 单次函数执行耗时突破 `timeout_ms` 阈值                           |
| **`SystemError`**          | `Exception` / `SystemError` | 选手函数执行崩溃抛错。异常消息包含由宿主清洗过绝对路径的安全堆栈 |
| **`ConnectionError`**      | IPC 断开                    | Solution Host 进程提前闪退或 IPC 管道破裂                        |

### 参数与返回值严格白名单校验

在发出网络帧之前，`SolutionRunner` 会在 Evaluator
进程内**深度递归校验传参类型**：

- **允许的合法类型**：`None`、`bool`、`int`、`float`、`str`、`bytes`、`list`、`dict`（**dict
  的键名必须为字符串 `str`**）；
- **非法类型即刻拦截**：若参数中包含自定义类实例、`set`、`tuple`、函数引用、生成器、文件句柄等，SDK
  **立即在本地抛出 `RejectedError`**，底层**绝不会发送任何 RPC
  帧**（保护选手容器不被非预期数据污染）。

---

## 注册受控能力（`register_capability`）

当题目需要向零网络的选手提供受控外部网络能力（如调用特定公网
API、大模型推理）时，由 Evaluator 注册反向代理能力：

```python
def query_weather_handler(city: str) -> dict:
    """仅接受城市名参数，目标 API 严格由 Evaluator 写死"""
    if not isinstance(city, str):
        raise ValueError("City name must be string")
    return fetch_from_weather_api(city)

# 注册 capability 并设置其被调用时的独立超时（单位：ms）
register_capability("query_weather", query_weather_handler, timeout_ms=5000)
```

::: danger 严禁双向嵌套调用（死锁红线） `register_capability` 绑定的 Handler
是在 Evaluator 进程的 **Runner 内部读取线程** 中同步执行的。
若在能力处理函数内部再次调用 `runner.call()`
去回调选手代码，**双方将陷入不可解的相互等待死锁**，最终只能等待全局总超时强杀！
:::

---

## 成绩上报与用例详情（`result` 模块）

评测结束前，出题人通过 `result` 模块写出评分结论并规范退出。

### 1. 结果提交接口

```python
# 判定满分
result.accept(score=100, details=summary_details)

# 判定部分分或 0 分
result.wrong_answer(score=60, details=summary_details)
```

::: warning 单次评测唯一提交准则
`result.accept()` 或 `result.wrong_answer()` **在单次评测中仅允许调用一次**！重复调用会抛出 `RuntimeError`。出题人写出结果后应立即让 `evaluate.py` 正常退场（`sys.exit(0)`）。
:::

### 2. 规范化测试点结构（`details.cases`）

为使前端能够渲染出清晰美观的测试点卡片，`details` 推荐使用扁平化的 `cases`
数组：

```python
details = {
    "cases": [
        {
            "case_id": "v1",
            "status": "Accepted",
            "hidden": False,  # 显式声明为公开可见用例
            "visibility": "visible",
            "time_ms": 15,
            "memory_kb": 24500,
            "input": "solve(3, 5)",
            "expected_output": "8",
            "actual_output": "8",
        },
        {
            "case_id": "h1",
            "status": "WrongAnswer",
            "hidden": True,  # 显式声明为盲测隐藏用例
            "visibility": "hidden",
            "time_ms": 22,
            "memory_kb": 26800,
            # 隐藏用例严禁出现 input / expected_output / actual_output !
        },
    ]
}
```

### 3. 用例安全防泄漏红线与 Fail-Safe 机制

- **隐藏用例脱敏红线**：标记为 `hidden: True` 的用例，**绝对禁止**携带
  `input`、`expected_output` 与 `actual_output`，防止在竞赛投影时向选手泄题；
- **全量字段校验**：**每个测试点对象必须显式携带 `hidden` 布尔字段**；
- **Fail-Safe 安全兜底**：若 `cases` 数组中存在任何一个用例缺少 `hidden` 或
  `visibility`
  标记，后端投影引擎为防止历史脚本意外泄密，将**对该次提交实施整体用例详情熔断（整份详情不予返回）**。

---

## 托管大语言模型调用（`llm` 模块）

对于 LLM 工程题，评测宿主自动向 Evaluator 容器注入 `NOJ_LLM_*`
环境变量。出题人可直接通过 SDK
预置的客户端发起请求，免去手动配置代理与签名的繁琐工作：

```python
from noj_evaluator_sdk import llm

# 直接与 noj-llm-gateway 交互，自动附带短期 eval_token
response = llm.complete(
    model="qwen-plus",
    messages=[
        {"role": "system", "content": "你是一名资深算法评审专家。"},
        {"role": "user", "content": f"请为选手的输出给出评估意见：{actual_ans}"},
    ],
    temperature=0.2,
)

eval_opinion = response["choices"][0]["message"]["content"]
```
