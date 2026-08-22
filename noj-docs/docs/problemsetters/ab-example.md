# A+B 示例题

本页使用 `1001` 样例题说明一次完整出题流程。

这里的 `visible.jsonl` 和 `hidden.jsonl` 是 A+B 样例题采用的数据组织方式，不是 Neuro OJ 的必选文件。正式题目可以用任意 evaluator 能读取的文件结构。

## 源文件

```text
noj-core/data/problems-src/1001/
├── evaluate.py
├── hidden.jsonl
├── problem.json
├── statement.md
├── template.py
└── visible.jsonl
```

## 题面接口

题目要求用户实现：

```python
def solve(a: int, b: int) -> int:
    ...
```

正确提交：

```python
def solve(a: int, b: int) -> int:
    return a + b
```

错误提交：

```python
print(2)
```

这个提交没有实现 `solve`，因此 evaluator 调用时会收到 `FunctionNotFound`，不应被当作系统错误。

## 测试数据

`visible.jsonl` 示例：

```json
{"id":"v002","input":"1 2\n","expected":3}
```

`hidden.jsonl` 示例：

```json
{"id":"h001","input":"2 2\n","expected":4}
```

## evaluator 关键逻辑

`evaluate.py` 会读取 JSONL，用 `SolutionRunner` 调用 `solve`：

```python
runner = SolutionRunner()                  # 创建调用器：负责向 Solution 容器转发 RPC 调用
a, b = parse_input(item["input"])          # 解析当前用例输入（如 "1 2\n" → (1, 2)）
raw_output = runner.call("solve", a, b)    # 调用用户实现的 solve(a, b)，返回其返回值
```

调用失败时捕获 `SolutionCallError`：

```python
except SolutionCallError as exc:           # 用户函数调用失败（抛异常 / 超时 / 函数未定义等）
    raw_output = None                      # 本次调用没有可用返回值
    output_text = ""                       # 失败调用不产生输出文本
    call_error = exc.error                 # 取出结构化错误：类型、消息与截断 traceback
```

最终根据通过数量和格式检查计算分数：

```python
if total_score == FULL_SCORE:                          # 全部用例通过且格式检查无误
    result.accept(score=score, details=details)        # 判定 Accepted：写入总分与用例详情
else:
    result.wrong_answer(score=score, details=details)  # 未达满分：判定 WrongAnswer（可带部分分）
```

## 打包

```bash
cd noj-core
deno task problems:build
```

生成：

```text
noj-core/data/packages/1001.zip
```

构建产物会包含 `evaluate.py`、`visible.jsonl` 和 `hidden.jsonl`，不会包含 `submission.py`。

## 上传到题目

正式出题时，不使用 `problems:import` 导入样例题。该流程只用于仓库内置样例题和开发环境初始化。

推荐流程：

1. 在 Web 管理界面创建 A+B 题，填写题面、难度、分类和运行时配置（或用统一题目包导入）。
2. 保存题目。
3. 在题目编辑页的"题目支持包"区域上传统一题目包（zip 含 `problem.json` + `statement.md` + `evaluate.py`）。
4. 上传成功后提交正确解法验证。

上传成功后，后端会剥离元数据、把纯净评测包注册到 StorageProvider，并更新题目的 `support_package_storage_url`。提交评测时，noj-core 会把它转换成 Judge Worker 可下载的 `noj-download://` URL。

## 本地样例题说明

仓库内置的 `1001` 是开发样例题。维护样例题时可以运行：

```bash
cd noj-core
deno task dev-setup
```

该命令会依次执行数据库迁移、系统初始化、管理员引导，并构建/导入统一题目包。这个流程服务于本地开发和测试，不是普通出题人的发布路径。
