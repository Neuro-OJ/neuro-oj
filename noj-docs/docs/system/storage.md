# 存储与评测包交付

> Neuro OJ 用两层 URL 把"资源存在哪"（持久存储）与"Judge 怎么拿"（评测交付）解耦。

对象类型、引用和只读生命周期盘点见[对象存储生命周期治理](./object-storage-governance.md)。

## 存储层 URL（noj-storage://）

`noj-storage://` 表示资源在存储后端中的位置，会写入数据库。格式为 `noj-storage://<provider>/<key>?checksum_sha256=<hex>`：

| 模式 | 示例 | key 形态 |
| --- | --- | --- |
| local | `noj-storage://local/<base64>?checksum_sha256=...` | 内容寻址（SHA-256 → base64url），图片带扩展名 |
| S3 | `noj-storage://s3/<key>?checksum_sha256=...` | 受控前缀，如 `packages/<problem_id>.zip` |

## 评测交付 URL（noj-download://）

`noj-download://` 表示 Judge Worker 如何获取纯净评测包内容，会放入评测任务：

| 交付方式 | 示例 | 适用场景 |
| --- | --- | --- |
| 内联 base64 | `noj-download://base64/?content=<base64>&checksum_sha256=...` | Judge 支持解析；当前业务 provider 不产生（测试/兼容用） |
| local 路径 | `noj-download://local?path=<绝对路径>&checksum_sha256=...` | core 与 judge 共享文件系统 |
| S3 presigned | `noj-download://s3?url=<encoded-presigned-url>&checksum_sha256=...` | 生产（推荐） |

::: warning 内联 base64 受 Redis 消息上限约束
`noj-download://base64` 会把支持包 Base64 内联进评测任务，经 Redis 传给 Judge。评测任务有 **16 MiB 的序列化消息上限**（`noj-core` Producer 侧强制），且需与用户代码、运行配置共同占用，因此可用的支持包大小远小于 16 MiB。大支持包或多实例部署**必须**使用 S3/MinIO 交付，避免把二进制内容重复编码并复制进 Redis 消息。
:::

::: danger 生产必须使用独立 S3 应用凭据
MinIO root 凭据仅供初始化和受限运维使用，**不能注入 `noj-core`**。生产环境 `STORAGE_PROVIDER` 必须为 `s3`，且启动期会校验 `S3_ENDPOINT` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` / `S3_BUCKET` 完整性。配置与轮换步骤见[生产密钥轮换 Runbook](../operators/production-secrets.md)。
:::

## 为什么要分两层

数据库只需要知道资源归属和校验和；Judge Worker 需要知道当前这次任务如何下载纯净评测包。把两者分开后，同一个数据库记录可以在 local、S3 或其他存储后端之间切换交付方式。

## 评测包生命周期

正式题目的默认生命周期：

1. 出题人在 Web 界面创建或编辑题目。
2. 出题人上传统一题目包 zip（根级含 `problem.json`/`evaluate.py`；旧式松散支持包上传已废弃）。
3. noj-core 校验并**剥离 `problem.json`/`statement.md` 元数据**，通过 StorageProvider 把纯净评测包注册为 `noj-storage://` URL。
4. noj-core 创建评测任务时把存储 URL 转换为 Judge Worker 可下载的 `noj-download://` URL。
5. noj-judge 下载、校验并缓存纯净评测包，再注入 Evaluator 容器执行评测。

::: info 支持包大小上限
单题支持包上限为 **128 MiB**（`MAX_SUPPORT_PACKAGE_SIZE`）。S3 化之后已不再受 Redis 16 MiB 消息限制。
:::

内置样例题的开发生命周期：

1. 维护者把样例题源文件放在 `noj-core/data/problems-src/<id>/`。
2. 维护者运行 `deno task problems:build` 生成 `noj-core/data/packages/<id>.zip`。
3. 维护者运行 `deno task problems:import`（或 `deno task dev-setup`）导入统一题目包，由 noj-core 剥离元数据并把纯净评测包注册到 StorageProvider。

::: tip 样例题与正式题目的边界
样例题流程仅用于开发和测试，**不是正式出题发布路径**。正式比赛题目（含隐藏测试数据与评测脚本）不得提交到 `data/problems-src/` 所在的 git 仓库。
:::
