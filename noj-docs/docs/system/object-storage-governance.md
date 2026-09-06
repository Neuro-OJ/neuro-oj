# 对象存储生命周期治理

本文档描述对象类型、数据库引用和当前生命周期边界。机器可检查的清单位于
[`dev-docs/engineering/object-storage-governance.json`](../../../dev-docs/engineering/object-storage-governance.json)。

## 当前阶段：只读盘点

第一阶段只建立事实基线，不新增对象删除策略：

```bash
cd noj-core
deno task storage:audit -- --pretty \
  --output /var/lib/noj/storage-audit.json \
  --prometheus-output /var/lib/node_exporter/textfile/noj_storage.prom
```

命令只执行数据库 `SELECT` 和对象存储 `LIST`，输出对象数量、字节数、按类型统计、
未被数据库引用的对象、数据库引用但对象不存在的记录，以及非法存储 URL。它不会调用
`delete`、`put` 或修改数据库。报告中的 orphan 不是“可直接删除”清单：跨环境引用、
备份恢复窗口和历史迁移都必须由运营者复核。

## 对象类型与引用

| 类型 | 数据库引用 | 常见 key | 当前生命周期 |
| --- | --- | --- | --- |
| 题目纯净评测包 | `problems.support_package_storage_url` | `packages/<problem_id>.zip`（local 为内容寻址） | 替换/删除题目时由业务路径清理；盘点不自动清理 |
| artifact 提交 | `submissions.artifact_storage_url` | `artifacts/<uuid>.zip` | 评测完成、入队失败、pending 超时孤儿由既有流程清理；本阶段不扩大范围 |
| 用户头像 | `users.avatar_url` | `avatar/<user_id>.<ext>` 或内容寻址 | 替换/清除时仅在确认没有其他引用后清理 |
| 私信图片 | `messages.image_url` | `message-images/<conversation_id>/<uuid>.<ext>` | 当前无新增自动回收；撤回/删除消息不等于可立即删除对象 |
| 备份快照 | 外部备份 manifest（不在业务表 URL 中） | `backups/` 或部署指定目的地 | 遵循备份保留与恢复演练要求，人工确认后处理 |

## 运行与告警

将 `noj_storage_objects_total`、`noj_storage_bytes`、`noj_storage_orphan_objects`、
`noj_storage_orphan_bytes`、`noj_storage_missing_references` 和
`noj_storage_audit_generated_at_seconds` 写入 node_exporter textfile collector 后，
由 Prometheus 观察数量/容量增长趋势。建议每日盘点；对象数量或字节数异常增长先查
artifact 入队失败、消息图片发送和备份任务，不要直接删除 bucket 或目录。

出现以下情况应暂停回收并人工复核：

- `missing_references_total > 0`（数据库仍引用但对象不存在）；
- provider、bucket、存储目录与部署配置不一致；
- orphan 对象的 `lastModified` 处于近期发布/恢复窗口；
- local 内容寻址对象被多个用户共享，或存在跨 provider 的历史 URL。

备份与 local 支持包路径需区分：`data/storage/` 是运行时纯净评测包，
`data/packages/` 是可重建的导入载体。生产环境必须使用 S3/兼容对象存储。
