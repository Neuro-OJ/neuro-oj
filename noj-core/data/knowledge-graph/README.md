# NOJ 官方知识图谱内容包

AI 竞赛知识图谱的默认内容：知识点（节点）与前置关系（边），覆盖 **IOAI**（2027
版考纲）、 **NOAI**（中国区选拔）与 **LMCC**（CCF 大模型能力认证 2026 年 5
月版）。功能设计见
[`openspec/changes/add-knowledge-graph/`](../../../openspec/changes/add-knowledge-graph/)。
内容采用 CC BY-SA 4.0，见 [LICENSE](LICENSE)。

> **状态：初稿（`2026.11.0-draft`），待懂 AI 竞赛的维护者评审。** 导入、校验与
> API 尚未实现 （提案 P0）。

## 结构

```text
pack.yaml            # 包 id、版本、许可、考纲说明
areas/<area>.yaml    # 每个领域一个文件
docs/<node-id>.md    # 节点讲解（预留，尚无内容）
```

节点字段：`id`（`<领域>.<名称>`，稳定、发布后不复用）、`name`、`summary`（一句原创说明）、
`syllabus`（`ioai` / `noai` /
`lmcc`）、`requires`（**直接**前置，不写可传递得到的间接前置）。

## 领域（14 个，181 个知识点）

| 领域        | 名称                   | 主要考纲         |
| ----------- | ---------------------- | ---------------- |
| `prog`      | 编程与工具             | 三者             |
| `math`      | 数学基础               | NOAI、IOAI       |
| `ai`        | 人工智能基础           | LMCC、NOAI       |
| `ml`        | 经典机器学习           | IOAI、NOAI       |
| `data`      | 数据科学与模型评估     | 三者             |
| `dl`        | 神经网络与深度学习     | IOAI、NOAI       |
| `cv`        | 计算机视觉             | IOAI、NOAI       |
| `nlp`       | 自然语言处理与音频     | IOAI、NOAI、LMCC |
| `rl`        | 强化学习               | IOAI             |
| `llm`       | 大模型基础与架构       | LMCC             |
| `llm-train` | 大模型训练、微调与对齐 | LMCC             |
| `llm-infer` | 大模型解码与部署       | LMCC             |
| `llm-app`   | 提示、推理与智能体     | LMCC             |
| `llm-eval`  | 大模型评测与安全       | LMCC             |

考纲覆盖：LMCC 114、IOAI 111、NOAI 70 个知识点（一个知识点可对应多个考纲）。

## 起草依据与可信度

- **IOAI**：官方 2027 版考纲全文（2026 年 11 月发布），可信度高。
- **LMCC**：CCF 官方大纲（2026 年 5 月版）的 12 个模块与 L1–L3
  分级，可信度高；青少年组与成人组 各自考哪些知识点在官方 PDF
  中为图片，未逐条核对。
- **NOAI**：官方完整大纲（2026 版
  V1.5）需报名领取，未获得；依据官方说明的转载与选拔说明，
  可信度中等，第一轮额外覆盖 Python 基础、数据结构与数学基础。

## 待评审问题

1. **NOAI 对应关系**需以官方 V1.5 大纲逐条核对。
2. 是否补充以下知识点（起草时提出，未加入）：矩阵分解与特征值；类别不平衡处理；目标检测指标
   （IoU、mAP）；以大模型为评委（LLM-as-judge）；提示自动优化；语音合成。
3. 粒度重叠：`dl.peft`（概念）与
   `llm-train.lora`、`llm-train.peft-variants`（方法）；
   `llm-infer.chat-template` 与 `llm-app.prompt-design`。
4. 前置关系是**建议性**的（不锁题），但会影响「前沿节点」推荐；当前最深链路约 18
   层 （至强化学习推理训练），请评审主线是否合理。

## 修改与贡献

修改走 PR 评审。规则：节点 ID 发布后不得改名或复用，删除只能标记 `deprecated`
并可指定 `replaced_by`；`summary`
必须原创，不得摘抄考纲、教材或网页原文；`requires` 只写直接前置且不得成环。
