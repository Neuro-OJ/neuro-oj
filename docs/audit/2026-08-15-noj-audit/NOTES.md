# NOJ 全模块审计 — 元数据

## 审计范围与基线

- **模块**：noj-core（~5.7 万行）、noj-ui（~2.1 万行）、noj-judge（~0.7 万行）、noj-docs（~0.3 万行）
- **基线**：`main` bookmark，commit `31150781`（`feat(core,ui,root): 支持用户头像上传（#229） (#239)`）
- **工作副本**：审计期间 WC 为 `kxqzmsts`（空变更，父提交 = main）。审计前原 in-flight 工作（题目标签系统）保留于提交 `vurvpmkt`（branch `problem-tags-replace-categories`），**未丢失**。
- **恢复命令**（如需回到审计前的工作）：`jj new vurvpmkt` 或 `jj edit mnszwlqn`

## 维度

正确性、安全性、性能、可靠性、OpenSpec 规范符合性、依赖与密钥卫生、代码质量、UI 可用性、文档准确性

## 严重级别

`严重`（可被直接利用的漏洞 / 必现数据损坏）> `高` > `中` > `低` > `信息`（纯建议）

## 方法

- 31 个 finder 子代理并行只读审查（按模块×维度划分）
- 对抗性 verifier 子代理分片复核全部发现（真/假阳性、严重级校准）
- 父代理跨模块去重、聚合，产出本目录报告
- 全程只读：未修改任何源码/配置；finder/verifier 仅用 read/grep/glob

## 产出

- `summary.md`：总览与 Top 发现
- `core.md` / `ui.md` / `judge.md` / `docs.md`：分模块明细
- `findings.json`：机器可读全量清单（含假阳性）

## 约定

- file 为相对仓库根路径；line 为行号或范围
- 报告中"in-flight"标注的问题仅涉及 main 之外内容时会被剔除
