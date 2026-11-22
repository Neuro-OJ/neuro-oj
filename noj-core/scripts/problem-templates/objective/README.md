# 模板：客观题试卷

由 `problem init --template objective` 生成的**可直接验题**的客观题模板：
单选、多选、判断三种题型，由平台按标准答案直接判分（不经过评测容器）。

## 文件

| 路径             | 说明                                                                       |
| ---------------- | -------------------------------------------------------------------------- |
| `problem.json`   | `kind: "objective"`，不需要 runtime_config / 模板 / LLM                    |
| `questions.json` | 题目数组：`key` / `type` / `prompt` / `options` / `answer` / `explanation` |
| `submissions/`   | 作答文件（`{题号: [答案]}`）与断言，**不进题目包**                         |

## 验题

```bash
noj-cli problem test .      # 全对 100、部分错 <50、空卷 0
noj-cli problem lint --strict .
```

## 改造步骤

1. 改写 `questions.json`：`key` 全卷唯一；题干写在 `prompt`；`options` 是
   `{"key", "text"}` 数组（判断题省略）；`answer` **总是数组**——单选 `["B"]`、
   多选 `["A", "D"]`、判断 `[true]`；`lint` 会按导入规则校验；
2. 每题写 `explanation`，作答后展示给选手；
3. 更新 `submissions/` 中的作答文件与 `expect.json`。

## 常见坑

- **多选题判分**：多选题需要完全匹配才得分，题干里请提示「多选」；
- **题干与选项支持 Markdown 与 `$...$` 公式**，注意 JSON 中反斜杠要写成 `\\`；
- **原创内容**：不要直接搬运真实考试或题库的原题。
