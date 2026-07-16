# A+B 示例题

本页使用 `1003` 样例题说明一次完整出题流程。

这里的 `visible.jsonl` 和 `hidden.jsonl` 是 A+B 样例题采用的数据组织方式，不是 NOJ 的必选文件。正式题目可以用任意 evaluator 能读取的文件结构。

## 源文件

```text
noj-core/data/problems-src/1003/
├── evaluate.py
├── hidden.jsonl
├── submission.py
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
runner = SolutionRunner()
a, b = parse_input(item["input"])
raw_output = runner.call("solve", a, b)
```

调用失败时捕获 `SolutionCallError`：

```python
except SolutionCallError as exc:
    raw_output = None
    output_text = ""
    call_error = exc.error
```

最终根据通过数量和格式检查计算分数：

```python
if total_score == FULL_SCORE:
    result.accept(score=score, details=details)
else:
    result.wrong_answer(score=score, details=details)
```

## 打包

```bash
cd noj-core
deno task build-packages
```

生成：

```text
noj-core/data/packages/1003.zip
```

构建产物会包含 `evaluate.py`、`visible.jsonl` 和 `hidden.jsonl`，不会包含 `submission.py`。

## 上传到题目

正式出题时，不使用 seed 注册支持包。seed 只用于仓库内置样例题和开发环境初始化。

推荐流程：

1. 在 Web 管理界面创建 A+B 题，填写题面、难度、分类和运行时配置。
2. 保存题目。
3. 在题目编辑页的“题目支持包”区域上传 `1003.zip`。
4. 上传成功后提交正确解法验证。

上传成功后，后端会把 zip 注册到 StorageProvider，并更新题目的 `support_package_storage_url`。提交评测时，noj-core 会把它转换成 Judge Worker 可下载的 `noj-download://` URL。

## 本地样例题说明

仓库内置的 `1003` 是开发样例题。维护样例题时可以运行：

```bash
cd noj-core
deno task setup
```

该命令会构建样例支持包并执行 seed。这个流程服务于本地开发和测试，不是普通出题人的发布路径。
