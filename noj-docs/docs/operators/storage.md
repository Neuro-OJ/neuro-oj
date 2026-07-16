# 存储与支持包交付

NOJ 使用两层 URL 区分持久存储和 Judge 交付。

## 存储层 URL

`noj-storage://` 表示资源在存储后端中的位置，会写入数据库。

本地模式示例：

```text
noj-storage://local/<base64>?checksum_sha256=...
```

S3 模式示例：

```text
noj-storage://s3/<key>?checksum_sha256=...
```

## Judge 交付 URL

`noj-download://` 表示 Judge Worker 如何获取支持包内容，会放入评测任务。

本地或内联交付示例：

```text
noj-download://base64/?content=<base64>&checksum_sha256=...
```

S3 交付示例：

```text
noj-download://s3?url=<encoded-presigned-url>&checksum_sha256=...
```

## 为什么要分两层

数据库只需要知道资源归属和校验和；Judge Worker 需要知道当前这次任务如何下载支持包。把两者分开后，同一个数据库记录可以在 local、S3 或其他存储后端之间切换交付方式。

## 支持包生命周期

正式题目的默认生命周期：

1. 出题人在 Web 界面创建或编辑题目。
2. 出题人上传支持包 zip。
3. noj-core 校验 zip，并通过 StorageProvider 注册为 `noj-storage://` URL。
4. noj-core 创建评测任务时把存储 URL 转换为 Judge 可下载的 `noj-download://` URL。
5. noj-judge 下载、校验并缓存支持包，再注入 Evaluator 容器执行评测。

内置样例题的开发生命周期：

1. 维护者把样例题源文件放在 `noj-core/data/problems-src/<id>/`。
2. 维护者运行 `deno task build-packages` 生成 `noj-core/data/packages/<id>.zip`。
3. seed 把样例题支持包注册到 StorageProvider。

样例题流程用于开发和测试，不是正式出题发布路径。
