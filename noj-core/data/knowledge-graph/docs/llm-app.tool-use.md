# 工具使用与函数调用

## 直觉理解

大语言模型靠参数记住的知识截止于训练时间，而且心算高精度乘法、查实时数据库或执行代码很容易编造结果。函数调用（Tool
Use / Function
Calling）就像给大模型配了一副“双手”：让它把“我要查什么、传哪些参数”按规范 JSON
说出来，由宿主程序安全执行后再把真实结果喂回对话继续推理。

## 核心概念

1. **标准调用闭环（Tool Loop）**：
   1. 宿主把 `tools`（工具名称、功能说明、JSON Schema
      参数定义）连同用户问题发给模型；
   2. 模型判断需要外部信息时，返回结构化 `tool_calls(name, arguments)`
      并暂停文本回复；
   3. 宿主校验参数与权限、执行工具，生成 `role: "tool"` 消息回传结果；
   4. 模型结合观察结果输出最终答复或继续下一轮工具调用。
2. **Schema
   与描述设计**：清晰的参数描述（类型、单位、必填项、枚举范围）往往比提示词里写一百句要求更能减少参数错传。
3. **安全与幂等防线**：对外部写操作（删文件、发请求、付款）必须加参数白名单校验与人工确认，不能盲信模型拼出的参数。

## 常见误区

- 不校验模型生成的参数类型或路径边界就直接 `eval` 或拼入
  SQL/Shell，导致注入漏洞或越权破坏。
- 把几十个重叠模糊的工具一股脑塞进上下文，使模型选错工具并白白消耗大量输入
  Token。

## 例题与完整解析

**题目**：实现一个受控单轮工具调度循环，根据模型返回的 `tool_call`
执行白名单函数并回传观测结果。

```python
import json

def get_order_status(order_id: str) -> dict:
    db = {"ORD-101": "shipped", "ORD-102": "pending"}
    return {"order_id": order_id, "status": db.get(order_id, "not_found")}

TOOLS = {"get_order_status": get_order_status}

# 模拟模型发出的工具调用请求
tool_call = {"name": "get_order_status", "arguments": '{"order_id": "ORD-101"}'}
fn = TOOLS.get(tool_call["name"])
if fn is None:
    raise PermissionError("Disallowed tool")
args = json.loads(tool_call["arguments"])
tool_result = fn(**args)

print("Tool observation:", json.dumps(tool_result, ensure_ascii=False))
```

**逐步讲解**：宿主通过 `TOOLS` 白名单映射拒绝未授权函数，先 `json.loads`
再显式调用目标函数，并将结果标准化为 JSON 观测值返回给模型。
