# 题目支持包

支持包是出题人交给 Judge Worker 的题目运行材料。它不包含用户提交代码。

## 最小结构

NOJ 对支持包的强制要求很少：zip 根层级必须包含 `evaluate.py`。其他文件如何组织由出题人决定。

最小支持包可以只有：

```text
├── evaluate.py
```

样例题通常还会放入测试数据和维护文件，例如：

```text
noj-core/data/problems-src/<id>/
├── evaluate.py
├── visible.jsonl
├── hidden.jsonl
├── submission.py
└── README.md
```

其中：

- `evaluate.py` 是评测入口，必须存在。
- `visible.jsonl` 和 `hidden.jsonl` 是当前内置样例题采用的 JSONL 约定，不是 NOJ 的必选文件。
- `submission.py` 或 `solution.py` 可作为参考实现，但不会打包进支持包。
- `README.md` 可记录题目说明或维护信息。

你也可以使用其他方式组织数据，例如：

- `cases/*.json`
- `fixtures/` 目录
- SQLite 数据库文件
- CSV、YAML、纯文本或二进制资源
- 在 `evaluate.py` 中动态生成测试输入

只要 `evaluate.py` 能在 Evaluator 容器内读取并完成评分即可。

## 打包规则

正式出题时，可以使用任意 zip 工具生成支持包。仓库中的 `deno task build-packages` 主要用于维护内置样例题和本地开发验证。

运行：

```bash
cd noj-core
deno task build-packages
```

构建脚本会扫描 `data/problems-src/<id>/`，生成：

```text
noj-core/data/packages/<id>.zip
```

构建时会排除：

- `submission.py`
- `solution.py`
- `__pycache__`
- `*.pyc`

## 通过 Web 界面上传

正式出题时，应通过 Web 管理界面上传支持包：

1. 打开管理后台或“我的题目”中的题目编辑页。
2. 创建题目并保存，或打开已有题目。
3. 在“题目支持包”区域上传 zip 文件。
4. 上传成功后，题目会显示“支持包已上传”。

后端会把 zip 保存到 StorageProvider，并把生成的 `noj-storage://` URL 写入题目的 `support_package_storage_url` 字段。后续提交评测时，noj-core 会把该存储 URL 转换为 Judge Worker 可下载的 `noj-download://` URL。

Web 上传会进行基础校验：

- 只接受 `.zip` 文件。
- 文件大小不能超过 128 MiB。
- zip 根层级必须包含 `evaluate.py`。
- zip 根层级不得包含 `solution.py` 或 `submission.py`。
- 支持包可以包含子目录，但 `evaluate.py` 必须在 zip 根层级，不要把整个题目目录作为唯一顶级文件夹打进去。

!!! warning "不要用 seed 发布正式题目"
    `deno task seed` 用于初始化样例题、分类、默认镜像和开发测试数据。正式出题应通过 Web 界面创建或编辑题目，并上传支持包。

## 支持包不包含什么

支持包不包含用户提交代码。用户代码由 noj-core 在提交时放入评测任务，再由 noj-judge 注入 Solution 容器。
