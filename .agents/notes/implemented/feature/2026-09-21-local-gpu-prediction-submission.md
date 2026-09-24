# Agent Note: 本地 GPU 预测提交题（服务端单容器判分）

Status: implemented

## Problem

AI 认证与竞赛场景需要一类「选手在自己的本地 GPU 上训练 / 推理」的题目（例：
Kaggle 传统赛形态）。这类题的数据集往往大到不适合随支持包分发，算力需求也超出
平台（平台无高性能 GPU）。但把「出分程序 + 隐藏判据」放到选手机器上会直接摧毁
评测可信度：选手同时握有裁判权，可读内存、改返回值、伪造分数。

既有两种提交模式都覆盖不了这个形态：

- **代码题（`code`）**：判据在 Evaluator，用户函数在 Solution 容器执行。适合小数据
  的函数级评测，但选手无法在评测环境里训练 GPU 模型。
- **产物提交（`artifact`）**：允许上传 zip 产物（模型 / 代码），但 zip 会解压到
  Solution 容器并执行 `submission.py`——仍然是「在服务端跑不可信代码」，且要求
  平台托管数据与依赖。

因此需要第三条路径：**选手只交数据，服务端只做确定性比对**。核心矛盾是——既要
让选手拿到公开数据、用尽本地算力，又不能让判据离开服务端。

## Decision

新增第三提交模式 `submission_mode = "prediction"`。

**信任边界（不可动摇约束）**：任何 prediction 评测的**隐藏标签、标准答案、评分脚本**
均不得写入选手可见的响应（含 `output` / `details`），也不得下发到选手机器。选手本地
只做「拿不到答案也能算出答案」的计算；平台不观测、不信任、也不需要信任选手机器。
隐藏判据留在服务端是本模式公平性的唯一基石。

**判定路径**：prediction 任务走 `noj-judge` 的**单容器**路径
（`src/prediction/mod.rs::evaluate_prediction`），只创建 Evaluator 容器，**不创建
Solution 容器、不执行任何不可信代码、无 NDJSON 编排**。攻击面小于现有双容器路径。
支持包（`evaluate.py` + 隐藏标签）注入 Evaluator `/workspace`；选手的单个预测文件经
**流式注入**写到 `/workspace/prediction/<文件名>`，该目录下只有这一个文件。

**契约**：`runtime_config` 的 `solution` 块在 prediction 模式下**省略**（Rust 侧
`RuntimeConfig.solution: Option`）；题目 `submission_mode` 显式表达模式，**不靠字段
缺席隐式推断**。

**文件格式治理**（双重防线）：

- 扩展名白名单 `.csv .tsv .jsonl .json .txt .npy .npz .parquet`；
- 扩展名黑名单（pickle 类）`.pkl .pickle .pt .pth .bin .joblib .ckpt`；
- 魔数检测：不论扩展名，pickle 协议头（`\x80\x04` / `\x80\x05`）一律拒绝；结构化
  文本前若干字节含 NUL 视为二进制伪装；`.npy` / `.npz` / `.parquet` 各自校验魔数。
- 违规返回 400 `PREDICTION_FORMAT_REJECTED`。
- Evaluator SDK `noj_evaluator_sdk.prediction.load_predictions()` 只做安全解析：不调用
  任何反序列化器，`.npy` / `.npz` 强制 `allow_pickle=False`。

**SDK**：新增 `noj_evaluator_sdk.prediction`——`load_predictions()`（自动定位唯一文件）、
`assert_id_alignment()`（数量 / 重复 / 缺失 / 多出全部报错）、确定性度量
`accuracy / f1_score / rmse / mae / roc_auc`、`values_equal()`（数值容差 + 数值字符串
归一化），以及 `emit_case_scores()`（写标准 `---RESULT---`，每个 case 带 `hidden: true`
且不携带隐藏标签）。SDK 的 import 不依赖 numpy（基础 Evaluator 镜像无 numpy），仅
`.npy` / `.npz` 分支惰性 import。

**生命周期复用**：预测文件写入 `submissions.artifact_storage_url`，因此免费复用 artifact
的四套既有生命周期——评测后删除对象、**不支持重测**、孤儿清理、相似度排除；大小上限
复用题目的 artifact 大小配置与系统硬上限。**平台不托管公开数据集**，由出题人在题面
外链，平台不校验公开数据与隐藏标签的一致性（出题人责任）。

**运行时配置**：新增 Judge 环境变量 `JUDGE_PREDICTION_WORKSPACE_MB`（默认 `2048`，范围
512–16384）作为 Evaluator `/workspace` tmpfs 的缺省大小；题目可用
`runtime_config.evaluator.workspace_size_mb` 覆盖。该变量**仅 judge 消费**，core 的
`settings-registry` / `.env.example` 不登记（裁决 PF-5）：core 不读它，登记反而制造
「core 拥有该配置」的假象。

**Phase 1 显式不做**：平台托管 GB 级数据集与独立上传入口、竞赛公开榜 / 私有榜、
prediction 重测 / 赛后重算、`/workspace/prediction` 只读 host bind mount、服务端 GPU 复算。

## Alternatives considered

- **约定式 artifact（模板 shim + 预测文件塞进 zip）**：不改 core / judge，仅靠出题约定
  把预测文件放进 zip、用 `submission.py` shim 喂给 evaluator。受 NDJSON RPC 类型与 512M
  tmpfs 限制，无格式治理，语义是 hack。**否决**，不作为产品形态。
- **服务端 GPU 重跑（选手交代码 / 权重）**：与「本地 GPU」目标冲突，需平台具备高性能
  GPU，项目已明确无此资源。**否决**。
- **用 `runtime_config.solution` 可选来隐式表达模式**（字段缺席即「无 Solution」）：
  隐式、与题目 `submission_mode` 语义重复、且会把「配置缺失」和「模式不同」混为一谈。
  **否决**，改用显式顶层 `submission_mode`（`solution` 可选只是该模式的契约后果）。
- **平台托管公开数据集**：项目所有者明确要求「出题人自行外链」。**移出范围**。
- **新增 `prediction_max_size_mb` / 新存储列**：多一次迁移与四套生命周期接线，收益仅为
  命名清晰。**否决**，复用现有字段与列（语义略宽，见 Consequences）。
- **支持 prediction 重测**：与「预测文件一次性、评测后删除」冲突，重算需求可重新提交。
  **否决**。
- **Phase 1 就做公开榜 / 私有榜**：私有榜是 score oracle 过拟合的正解，但可独立交付且
  需竞赛侧改造。**推迟到 Phase 2**。
- **允许 pickle 并做沙箱反序列化**：pickle 反序列化即任意代码执行，与「数据非代码」的
  前提根本冲突，任何沙箱化尝试都在扩大攻击面。**否决**，直接禁用。

## Consequences

- **正面**：在不削弱现有信任边界的前提下支持本地 GPU 出分；prediction 路径**没有不可信
  代码执行**，攻击面小于双容器；复用 artifact 生命周期与契约骨架，改动集中在「新增一条
  判分路径」；为后续 ML / GPU 题与大数据集奠定形态。
- **负面**：平台不托管数据集，**无法校验公开数据与隐藏标签的一致性**（出题人责任，且
  换数据会导致分数失真）；Phase 1 无私有榜，score oracle 过拟合仅由 per-problem 提交
  限次约束；预测文件受容器 `/workspace` tmpfs 容量限制，大文件占用 Worker 内存。
- **中性**：`submissions.artifact_storage_url` 同时承载 artifact zip 与 prediction 文件，
  列语义略宽；`runtime_config.solution` 在 prediction 模式下省略，使该字段成为可选。
- **必须延续的不变量**：任何后续 prediction 相关改动（新格式、新度量、新诊断字段、
  重测能力）都不得让隐藏标签 / 标准答案 / 评分脚本进入选手可见响应或选手机器；一旦需要
  判据离开服务端，该题就不属于 prediction 模式。
