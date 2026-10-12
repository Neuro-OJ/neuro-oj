# Solution SDK 规范手册

在 Neuro OJ
中，做题人无需编写庞杂的脚本启动命令，也无需处理标准输入流的文本切割解析。选手提交的代码被置于完全物理断网的
**Solution 容器** 中执行，仅需以简洁的 Python 顶层函数形式导出算法实现。

---

## 核心契约：顶层函数导出

做题人只需按照题目要求，在提交代码中实现指定的顶层函数。例如在基础题目中：

```python
# 按照题目要求的函数名与入参签名实现
def solve(a: int, b: int) -> int:
    return a + b
```

### 1. 宿主加载机制

- **代码物理注入**：评测引擎将选手的提交内容固化为沙箱内的
  `/workspace/main.py`；
- **守护反射导出**：沙箱内部启动的 `noj_solution_sdk.host` 进程将 `main.py`
  作为模块加载（内部模块名固定为
  `user_solution`），自动利用反射机制识别并向裁判端注册所有顶层定义的函数。

### 2. 顶层作用域执行纪律

在 `main.py` 模块加载阶段，**位于全局作用域（Top-Level）的代码会被即刻执行**：

- **推荐实践**：仅在全局顶层定义函数、算法常量、预计算表格（Look-up
  Tables）或类定义；
- **禁止行为**：严禁在全局顶层执行死循环、耗时昂贵的预热运算或抛出未捕获异常。顶层崩溃将导致
  Solution Host 加载失败，使得评测尚未开始即以 `error` 终结。

---

## 标准输入输出与调试日志准则

::: danger print() 不是答案输出信道
在 Neuro OJ 的评测体系中，**`print()` 语句绝对不会被作为算法答案进行比对**：

1. Solution 容器的标准输出（`stdout`）是严密的 **NDJSON 进程间通讯协议管道**；
2. 选手代码若随意调用 `print("...")`，该文本将被底层协议网关判定为非协议杂质并**自动丢弃过滤**，绝不会出现在最终结果面板中；
3. **正确做法**：始终通过 `return` 语句返回计算答案。
:::

---

## 异常产生与协议错误码

当做题人的代码在被 Evaluator 远程调用时产生故障，Solution Host
会捕获现场并回传结构化错误帧：

| 代码运行状况                         | 回传协议 Code | Evaluator 端表现 | 选手端诊断提示                                        |
| ------------------------------------ | ------------- | ---------------- | ----------------------------------------------------- |
| **拼写错误 / 缺少函数**              | `NotFound`    | `NotFoundError`  | "目标函数不存在，请检查函数名是否与题面一致"          |
| **运行时异常（如除以零、数组越界）** | `Exception`   | `SystemError`    | 捕获具体异常类型及过滤敏感系统路径后的堆栈跟踪        |
| **返回值不合法**                     | `Rejected`    | `RejectedError`  | "返回值类型不受支持，或返回值单帧体积超限（> 1 MiB）" |

---

## 反向调用受限能力（`call_capability`）

对于需要访问外部智能体、预训练模型或知识库的 AI
工程题，由于选手沙箱处于物理断网状态（`network_mode="none"`），系统提供了反向能力调用机制：

```python
from noj_solution_sdk import call_capability

def solve_query(prompt: str) -> str:
    # 通过 Evaluator 注册的 capability 代理安全发起外部推理
    response_text = call_capability("request_llm_completion", prompt)
    return response_text
```

### 1. 调用机制与参数约束

- `call_capability(name, *args)`：通过双向 IPC 管道经评测宿主中转，由 Evaluator
  容器内的受信 Handler 代理执行外部调用；
- 传递参数与接收的返回值均须符合
  [RPC 数据类型白名单](./rpc.md)（仅支持原生基础类型与嵌套结构，不支持任意对象引用）。

### 2. 客户端异常捕获

若能力调用发生异常，SDK 在选手侧抛出强类型异常：

- **`CapabilityNotFoundError`**：请求的能力名称在题目中未声明；
- **`CapabilityRejectedError`**：调用入参或返回值无法通过序列化白名单校验；
- **`CapabilityError`**：服务端能力处理函数内部执行抛错；
- **`CapabilityConnectionError`**：评测宿主间网络中断或 Evaluator 崩溃。

::: tip 普适性原则
对于绝大多数纯粹的算法训练与竞赛题目，选手**无需导入任何 SDK 模块**，编写纯正的原生 Python 代码即可。
:::
