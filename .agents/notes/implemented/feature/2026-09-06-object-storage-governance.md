# Agent Note: 对象存储只读盘点与生命周期治理基线（#450）

Status: implemented

## Problem

题目纯净评测包、artifact 提交、用户头像、私信图片和备份快照由不同模块产生，
引用字段、删除路径和保留语义没有统一清单。对象数量与容量增长缺少可重复观测，
在此基础上直接配置 bucket 生命周期规则可能误删仍被引用对象，或把 local 内容寻址
对象的共享引用当成孤儿。

## Decision

- 新增机器可检查清单 `dev-docs/engineering/object-storage-governance.json`，固定对象
  类型、DB 引用、key 前缀、现有清理路径和“本阶段不新增自动删除”边界。
- 为 StorageProvider 增加只读 `listObjects()` 能力：local 盘点文件和大小，S3 使用
  `ListObjectsV2` 分页；不提供任何删除副作用。
- 新增 `deno task storage:audit`：读取四类 DB 引用并与 inventory 比较，输出 JSON
  报告（orphan、missing reference、非法 URL、对象数量和字节数）及可供 textfile
  collector 使用的 Prometheus gauges。
- 盘点只报告 orphan，不自动回收；已有 artifact 入队失败/评测完成/pending 超时
  清理行为不扩大范围，并在治理文档中明确其边界。

## Alternatives considered

- 直接配置 S3/MinIO 生命周期规则：拒绝。数据库引用与跨环境/备份恢复窗口尚未被
  完整证明，存在误删风险。
- 只写静态文档：不足。无法发现实际 bucket/目录中的孤儿、缺失对象和容量增长。
- 在每次 `/metrics` 请求中实时列举 bucket：拒绝。LIST 可能昂贵且会把外部存储
  波动引入 core 请求路径，改为按日运行盘点并写 textfile 指标。

## Consequences

- 运维可按日生成可审计的只读报告，并观察对象数量/容量/孤儿趋势。
- 报告中的 orphan 必须人工复核，当前不会自动删除任何对象；后续若要治理回收，
  需要先补跨 provider、共享引用、备份恢复窗口和 dry-run/审批设计。
- StorageProvider 新增可选能力，已有测试替身无需立即实现；正式 local/S3 实现均
  支持盘点。
