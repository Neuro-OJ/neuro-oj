# A+B 示例题

本页使用 `1001` 样例题说明一次完整出题流程。

::: info 数据组织可自由选择
这里的 `visible.jsonl` 和 `hidden.jsonl` 是 A+B 样例题采用的数据组织方式，**不是** Neuro OJ 的必选文件。正式题目可以用任意 evaluator 能读取的文件结构。
:::

## 源文件

```text
noj-core/data/problems-src/1001/
├── evaluate.py      # 评测脚本（必须位于包根级）
├── problem.json     # manifest（题面/配置元数据）
├── statement.md     # 题面
├── visible.jsonl    # 可见测试点
├── hidden.jsonl     # 隐藏测试点
└── template.py      # 初始代码模板（不进入评测包）
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

这个提交没有实现 `solve`，因此 evaluator 调用时会收到 `NotFoundError`（协议 code 为 `NotFound`）。

::: warning 调用异常如何落地为状态
`NotFoundError` 是**调用级错误**，不等于最终 verdict。样例 `1001` 的 `evaluate.py` 未捕获该异常、直接抛出，进程未输出 `---RESULT---`，judge 将其映射为 **`error`**。
若你希望"函数缺失"算作一个失败用例（最终 `finished` + 0 分），应在 evaluator 中 `try/except NotFoundError` 并记录为失败用例。取舍见 [Evaluator SDK 错误处理](evaluator-sdk.md)。
:::

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
# 记录本次调用耗时，并输出 case_id/status/hidden/time_ms/expected_output/actual_output
```

调用失败时 SDK 抛出对应异常，样例 `1001` 直接向上抛（交由 judge 收尾为 `error`）：

```python
try:
    output_line = runner.call("solve", item["input"])
except SolutionTimeoutError:
    raise                    # 单次调用超时：不再消耗其余测试点的总时限
except Exception as e:
    print(f"  [!] Solution 调用异常: {e}")
    raise                    # 运行期错误：令 evaluator 不输出 ---RESULT---，judge 收尾为 error
```

> 如需把异常按失败用例处理（最终 `finished` + 部分分），改为不 `raise`、把该用例记为失败即可。

最终根据通过数量和格式检查计算分数：

```python
if total_score == FULL_SCORE:                          # 全部用例通过且格式检查无误
    result.accept(score=score, details=details)        # 写入总分与用例详情
else:
    result.wrong_answer(score=score, details=details)  # 未达满分：写入部分分
```

::: warning 结果 JSON 不再包含 `status`
`result.accept` / `result.wrong_answer` 只写 `{score, details}`，judge 统一映射 `finished` / `error`。分数是唯一结果，`Accepted` / `WrongAnswer` 仅作 `details.cases` 用例级参考信息。
:::

标准测试点字段至少包含 `case_id`、`status`、`hidden`（布尔值，`true` 为隐藏用例、`false` 为可见用例）和 `time_ms`：

| 字段 | 可见用例 | 隐藏用例 |
|------|:---:|:---:|
| `case_id` / `status` / `hidden` / `time_ms` | ✅ | ✅ |
| `input` / `expected_output` / `actual_output` | ✅ 可含 | ❌ 不得输出 |

隐藏测试点只返回用例 ID、状态、`hidden` 与资源耗时，**不得**把隐藏输入或标准答案写入 `details`。仓库内 `1001` 的 `evaluate.py` 已按该契约输出 `hidden` 标记。

## 打包

```bash
cd noj-core
deno task problems:build
```

生成：

```text
noj-core/data/packages/1001.zip
```

构建产物会包含 `evaluate.py`、`visible.jsonl` 和 `hidden.jsonl`；**不会**包含 `submission*`（参考实现）、`template.py`（manifest 声明的模板文件）与 `__pycache__`。

::: tip 模板不进入评测包
初始代码模板（`template.py`）仅供前端编辑器填充用户代码，与评测参考实现解耦，不属于评测内容。
:::

## 上传到题目

正式出题时，不使用 `problems:import` 导入样例题。该流程只用于仓库内置样例题和开发环境初始化。

推荐流程：

1. 在 Web 管理界面创建 A+B 题，填写题面、难度、标签和运行时配置；或直接用统一题目包导入（包内 `problem.json` 必须带 `runtime_config`）。
2. 保存题目。
3. 在题目编辑页的"题目支持包"区域上传统一题目包（zip 含 `problem.json` + `statement.md` + `evaluate.py`）。
4. 上传成功后提交正确解法验证。

上传成功后，后端会剥离元数据、把纯净评测包注册到 StorageProvider，并更新题目的 `support_package_storage_url`。提交评测时，noj-core 会把它转换成 Judge Worker 可下载的 `noj-download://` URL。

::: warning 上传的 zip 是"导入载体"而非纯净评测包
上传的 zip 必须含 `problem.json`（唯一导入入口）；后端会剥离 `problem.json` / `statement.md` 后重建纯净评测包再存储。直接上传只含 `evaluate.py` 的 zip 会在导入时被拒（根级缺 `problem.json`）。
:::

## 本地样例题说明

仓库内置的 `1001` 是开发样例题。维护样例题时可以运行：

```bash
cd noj-core
deno task dev-setup
```

该命令会依次执行数据库迁移、系统初始化、管理员引导，并构建/导入统一题目包。这个流程服务于本地开发和测试，不是普通出题人的发布路径。
