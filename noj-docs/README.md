# NOJ 文档站

`noj-docs` 是 Neuro OJ 面向做题人、运营者和出题人的正式文档站，使用 MkDocs Material 构建。

## 本地预览

```bash
cd noj-docs
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
mkdocs serve
```

默认预览地址为 `http://127.0.0.1:8000`。

## 严格构建

```bash
cd noj-docs
mkdocs build --strict
```

严格构建会检查导航和内部链接。提交文档变更前应至少运行一次。

## 维护约定

- 正文优先使用中文，代码标识符、命令、状态名和协议字段保留原文。
- 面向读者写作，避免混入内部开发流程或实现讨论。
- 出题人文档必须与 `noj-core/data/problems-src`、支持包构建脚本和 `noj-judge` Python SDK 的当前行为一致。
- 当评测协议、SDK 或 seed 脚本变化时，同步更新对应文档。
