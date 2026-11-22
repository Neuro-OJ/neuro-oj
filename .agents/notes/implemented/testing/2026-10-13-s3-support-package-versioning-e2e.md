# Agent Note: S3 支持包草稿与历史引用验收契约

Status: implemented

## Problem

旧 S3 用例调用已经退役的独立支持包上传入口，忽略草稿 revision
和显式发布；部分删除断言只打印提示，不能证明历史版本仍引用的对象实际保留。仅设置测试进程的
S3 地址也不能证明 core 使用 S3。

## Decision

重写 `noj-tests/e2e/submission/support_package_s3.test.ts` 的八项测试，统一使用
format 2 题目包从显式 main 域导入草稿，再通过 revision 显式发布。普通作者仅获得
main
的资源编辑者角色，断言没有平台治理身份；评测配置使用平台默认命令且不联网，不新增敏感字段权限。

覆盖普通作者导入、平台管理员代为更新、非作者写入与下载拒绝、缺失或冲突的
`If-Match`、非 ZIP
拒绝、无包下载、草稿删除和历史引用守卫。每项独立建立题目，草稿更新不会提前改变已发布版本的支持包。

测试要求显式 S3 运行标志和端点。启用后检查 core 有效 provider、真实
`noj-storage://s3/` 存储引用及校验和，并用与 core 相同版本的 AWS SDK 从隔离
MinIO 只读核对长度、字节和 SHA-256。删除草稿包并发布无包 V3 后，V1、V2
包仍必须能从 MinIO 读取，而当前版本的 core
下载返回无包。该操作检查物理引用守卫，不为普通用户提供存储直链。

独立下载和删除暂用默认域兼容入口，因为当前接口没有显式域支持包管理下载路由；创建、导入、草稿和发布均携带明确
main 上下文。不重新开放已经移除的上传接口。

## Alternatives considered

- 保留旧上传 API 的调用并修改成功码：该接口明确移除，不能据此验证现产品流程。
- 把普通作者提升为平台管理员：会绕过真正的 Domain
  授权，因此只授予本域内置编辑者身份。
- 仅依赖当前版本下载证明历史对象存在：不能证明旧版本对应的独立 S3
  对象保留，因此按已授权管理视图取得的固定对象引用做运维只读核验。
- 没有 S3 runtime 时把测试作为通过：八项用例明确标记
  ignored，不打印虚假的上传或引用守卫成功。

## Consequences

AWS SDK 固定为 core 当前锁定的 `@aws-sdk/client-s3@3.1078.0`，依赖锁文件由正常
Deno 工具生成，未手工改写。其他题包依赖复用已有 fflate。

2026-10-13 主 agent 在独立数据库 `noj_upgrade_s3_e2e_20261013` 初始化并启动真实
S3 core，使用隔离 MinIO 的 `noj-support-packages` bucket 执行标准 submission
过滤入口，结果为 8 passed、0 failed、36 filtered out（1 秒）。实际核对字节、
长度、SHA-256 和历史 V1/V2 保留，不将此前 local 栈的 ignored 计作验收。 日志为
`/tmp/noj-root-s3-support-package-real-20261013.log`。

运行使用根目录 `docker-compose.e2e-s3.yml` 覆盖层，基础栈默认仍为 local。
数据库名称由基础 Compose 的 `E2E_DATABASE_NAME` 显式指定；主 agent 协调重启
和恢复 local 栈，未修改原开发数据库。

core 需配置 `STORAGE_PROVIDER=s3`、可达的 MinIO 端点、区域、访问凭据、bucket 和
path style，并在配置后重启以初始化 provider。测试侧使用宿主机可达的 MinIO
端点及隔离运维凭据，执行标准
`deno task test:domain submission --filter=e2e/s3-support-pkg`。
