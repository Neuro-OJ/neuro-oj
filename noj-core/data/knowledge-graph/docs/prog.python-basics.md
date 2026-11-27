# Python 基础语法（变量、控制流、函数）

## 直觉理解

写程序就像给助手写操作说明书：变量负责记住当前手头的数据，条件分支（`if / elif / else`）决定遇到不同情况怎么选路，循环（`for / while`）把重复工作自动化，函数则把一段经常用的步骤封装成带名字的工具箱。

## 核心概念

1. **变量与动态类型**：变量名绑定到对象引用，常见基础类型包括
   `int`、`float`、`bool`、`str`、`None`。判等用 `==`，判断 `None` 建议用
   `is None`。
2. **控制流**：`if / elif / else` 按缩进块执行；`for x in iterable`
   适合遍历序列或区间 `range(n)`，`while` 适合条件不确定何时停止的循环，配合
   `break` / `continue` 精确控制退出时机。
3. **函数与作用域**：用 `def fn(arg, default=0):` 封装逻辑并显式 `return`
   结果。避免把可变对象（如 `[]`、`{}`）直接写成函数默认参数。

## 常见误区

- 把可变列表写成默认参数
  `def append_item(x, buf=[]):`，导致多次调用共享同一个列表。正确写法是
  `buf=None` 再在函数内初始化。
- 在循环体内直接修改正在遍历的列表导致跳元素，应改用新列表收集或列表推导式。
- 混淆 `print()`（只输出到控制台）和 `return`（把结果交给调用方继续计算）。

## 例题与完整解析

**题目**：统计给定整数列表中所有正偶数的平均值，若没有正偶数则返回 `0.0`。

```python
def mean_positive_even(nums: list[int]) -> float:
    total = 0
    count = 0
    for x in nums:
        if x > 0 and x % 2 == 0:
            total += x
            count += 1
    return total / count if count > 0 else 0.0


print(mean_positive_even([-4, 0, 3, 4, 6, 7]))  # 输出: 5.0
print(mean_positive_even([-2, 1, 3]))           # 输出: 0.0
```

**逐步讲解**：使用 `count == 0` 保护除法避免除零异常；条件
`x > 0 and x % 2 == 0` 同时过滤掉负数、零和奇数。
