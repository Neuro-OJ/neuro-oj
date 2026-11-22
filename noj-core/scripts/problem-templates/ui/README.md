# 模板：界面题（规则调参）

由 `problem init --template ui` 生成的**可直接验题**的界面题模板：选手在
`ui.html` 里填写参数，平台把参数注入
`template.py`，评测脚本像代码题一样调用其中的函数。

## 文件

| 路径           | 说明                                                      |
| -------------- | --------------------------------------------------------- |
| `problem.json` | `submission_mode: "ui"`                                   |
| `statement.md` | 题面：参数含义与评分                                      |
| `ui.html`      | 题目界面（沙箱 iframe，只能通过 `window.NOJ` 与平台通信） |
| `template.py`  | 脚本模板（出题人逻辑，不下发给选手），使用注入的 `PARAMS` |
| `evaluate.py`  | 评测脚本：逐条调用 `classify()`，按 F1 计分               |
| `hidden.jsonl` | 隐藏用例                                                  |
| `submissions/` | 参数 JSON（等同界面提交内容）与断言，**不进题目包**       |

## 验题

```bash
noj-cli problem test .      # 调好的参数 100、粗糙参数 <80、空参数 0
noj-cli problem lint --strict .
```

## 改造步骤

1. 改写 `ui.html` 控件，`NOJ.onInit` / `NOJ.onSet` 时刷新控件、变化时
   `NOJ.setValues`；
2. 改写 `template.py`：**不要假设参数存在或类型正确**，一律从 `PARAMS`
   取值并校验；
3. 改写 `evaluate.py` 的调用与评分；
4. 更新 `submissions/` 中的参数文件与 `expect.json`。

## 常见坑

- `ui.html` 不能发起任何网络请求，脚本、样式、图片都要内联，大小不超过 512 KiB；
- 参数字段名必须是字母开头的字母、数字、下划线，最多 100 个；
- 空参数 `{}` 要能正常评测（得低分），不能让脚本抛异常变成平台错误；
- **隐藏用例泄露**：界面题没有可见用例时，不要在结果里回显隐藏数据。
