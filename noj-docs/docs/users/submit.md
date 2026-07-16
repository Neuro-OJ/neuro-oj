# 提交代码

## 选择语言

当前样例题主要使用 Python 运行时。页面中的语言选项会决定提交文件名和评测运行时配置。

## 实现题面要求的函数

优先实现题面声明的函数。例如：

```python
def solve(a: int, b: int) -> int:
    return a + b
```

不要依赖顶层 `print()` 作为答案输出。NOJ 的 Python 双容器评测会通过 Solution Host 加载你的模块，并由 evaluator 调用函数。

## 调试输出

你可以使用 `print()` 辅助调试，但它不是答案通道。Python Solution Host 会把用户代码的 stdout 重定向到 stderr，避免破坏评测协议。

## 常见错误

- 函数名写错：评测详情中可能出现 `FunctionNotFound`。
- 返回类型不符合题目要求：通常会被 evaluator 判为 WrongAnswer。
- 抛出异常：评测详情中会记录异常类型和消息，具体是否给分由题目 evaluator 决定。
- 超时或占用内存过高：Judge Worker 会返回对应资源限制状态。
