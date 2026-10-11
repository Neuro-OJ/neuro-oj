# 提示词题

提示词题（`submission_mode: "prompt"`）面向 Prompt 工程类考查：选手**不写代码**，
直接在做题工作区里编辑一段提示词文本并提交，evaluator 取回这段提示词，再调用
LLM（或任意自定义逻辑）完成评分。

和"代码题里放一个 `PROMPT` 字符串让选手改"相比，提示词题有这些好处：

- 选手进入的是专用的提示词编辑界面（左侧题面、右侧提示词与评测结果），不用理解 Python 语法；
- 提交记录里保存的是**提示词原文**，查看提交、查重都更直观；
- 选手无法在 Solution 容器里执行任何自定义代码，攻击面更小。

## 工作原理

```text
选手编辑提示词 ──提交──▶ noj-core
                         │  submissions.code 保存原文（language = "prompt"）
                         │  构造评测任务时包装为 Python 模块 main.py
                         ▼
                   Solution 容器：PROMPT 常量 + get_prompt()
                         ▲
                         │ runner.call("get_prompt")
                   Evaluator 容器：evaluate.py ──llm.complete──▶ LLM 网关
```

包装后的 Solution 模块只暴露一个函数：

```python
def get_prompt() -> str:  # 返回选手提交的提示词原文
    ...
```

提示词以 Base64 形式嵌入模块，选手文本中的引号、反斜杠等不会破坏源码，也无法注入代码。

## 题目配置

在 `problem.json` 中声明 `submission_mode`，并把模板指向一个提示词初稿文件
（例如 `template.md`），它会作为编辑区的初始内容：

```json
{
  "format_version": 1,
  "title": "情感分类提示词",
  "type": "P",
  "submission_mode": "prompt",
  "template": "template.md",
  "llm": { "max_calls": 30, "max_tokens": 20000 },
  "runtime_config": {
    "evaluator": {
      "image": "noj-evaluator-python",
      "time_limit_ms": 120000,
      "memory_limit_mb": 256,
      "network": { "enabled": true }
    },
    "solution": {
      "image": "noj-solution-python",
      "call_timeout_ms": 5000,
      "memory_limit_mb": 128
    }
  }
}
```

- 在 Web 题目编辑器中也可以把「提交模式」切换为「提示词提交（prompt）」。
- 需要调用 LLM 时，`llm` 与 Evaluator 联网等前置条件与
  [LLM 智能体调用题](llm-problem.md) 完全相同。
- 提示词题同样受 100KB 提交大小上限约束。

## Evaluator 示例

```python
from noj_evaluator_sdk import llm
from noj_evaluator_sdk.runner import SolutionRunner

runner = SolutionRunner()
prompt = str(runner.call("get_prompt"))

for case in load_cases():
    # 约定占位符由出题人在题面中说明，例如 {text}
    user_content = prompt.replace("{text}", case["input"])
    resp = llm.complete(
        messages=[{"role": "user", "content": user_content}],
        temperature=0,
    )
    answer = resp["choices"][0]["message"]["content"].strip()
    ...  # 与 case["expected"] 比对并累计得分
```

::: tip 占位符约定写进题面
平台不会在评测时解析提示词内容，`{text}` 之类的占位符、system / user 分段规则都由出题人在题面中约定，
并在 evaluator 中自行替换或拆分。

请在题面中用**行内代码**写出占位符（如 `` `{text}` ``）：提示词编辑界面会据此列出占位符，
标出选手尚未使用的项，并支持点击插入。普通文本或公式里的花括号不会被识别。
:::

## 选手侧体验

- 题目页「编写提示词」进入专用的提示词编辑界面（不进入代码编辑器）：左侧题面可收起，
  右侧为提示词编辑区，草稿自动保存在浏览器本地，可一键「恢复初稿」。
- 编辑区上方列出题面声明的占位符：已使用为绿色、缺失为琥珀色，点击即可插入到光标处。
- 「自测」会用当前提示词完整跑一次评测且不计入正式提交；`Ctrl/⌘ + Enter` 快捷自测。
- 下方「运行历史」合并列出每一轮自测与提交，**每轮使用的提示词都会随记录保存在服务端**：
  - 「对比」：查看该轮提示词与当前编辑内容的逐行差异；
  - 「回滚」：把编辑区恢复为该轮的提示词，回滚后未继续编辑前可「撤销回滚」；
  - 提交记录可跳转提交详情，「自测输出」标签页显示最近一次自测的输出。
