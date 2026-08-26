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

当前仓库 `1001` 样例题要求用户实现：

```python
def solve(input_str: str) -> str:
    ...
```

输入是一行两个空格分隔的整数，返回它们的和（字符串形式）。

正确提交：

```python
def solve(input_str: str) -> str:
    a, b = map(int, input_str.split())
    return str(a + b)
```

错误提交：

```python
print(2)
```

这个提交没有实现 `solve`，因此 evaluator 调用时会收到 `NotFoundError`，不应被当作系统错误。

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

`evaluate.py` 会读取 JSONL，用 `SolutionRunner` 调用 `solve`，并将每个可见测试点
的结果写入标准 `details.cases`：

```python
runner = SolutionRunner()                  # 创建调用器：负责向 Solution 容器转发 RPC 调用
output_line = runner.call("solve", item["input"])   # 传入原始 input 字符串
actual = output_line.strip().splitlines()[-1] if output_line.strip() else ""
expected = str(item["expected"]).strip()
# 记录本次调用耗时，并输出 case_id/status/time_ms/expected_output/actual_output
```

调用失败时捕获 SDK 异常：

```python
try:
    output_line = runner.call("solve", item["input"])
except SolutionTimeoutError:
    raise                    # 交由评测机识别为单次调用超时
except Exception as e:
    output_line = ""
    runtime_error = True
    print(f"  [!] Solution 调用异常: {e}")
```

最终根据通过数量和格式检查计算分数：

```python
if total_score == FULL_SCORE:                          # 全部用例通过且格式检查无误
    result.accept(score=score, details=details)        # 判定 Accepted：写入总分与用例详情
else:
result.wrong_answer(score=score, details=details)  # 未达满分：判定 WrongAnswer（可带部分分）
```

标准测试点字段至少包含 `case_id`、`status` 和 `time_ms`。可见测试点可以额外包含
`input`、`expected_output` 和 `actual_output`；隐藏测试点只返回用例 ID、状态与资源
耗时，不得把隐藏输入或标准答案写入 `details`。

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

1. 在 Web 管理界面创建 A+B 题，填写题面、难度、标签和运行时配置（或用统一题目包导入）。
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
