# Agent Note: MinIO 官方镜像与二进制全面下架后的镜像来源迁移

Status: implemented

## Problem

2026-09-26 实测：**MinIO 已停止免费分发**，官方镜像与二进制同时不可获取：

| 来源 | 实测结果 |
| --- | --- |
| `minio/minio`、`minio/mc`（Docker Hub） | 整组织 **404**（仓库已删除；`docker manifest inspect` → `denied / authentication required`） |
| `quay.io/minio/minio:RELEASE.2024-11-07T00-52-20Z` | `no such manifest` |
| `dl.min.io`（server 与 mc 二进制） | HTTP **410 Gone** |

影响三处，且都不是"重试即可"的偶发问题：

1. **E2E 全红**：`docker-compose.e2e.yml` 里钉的 `quay.io/minio/*` 无法拉取，5 个 Domain E2E job 全部停在「初始化 MinIO bucket」步。`E2E Browser`（未改动任何代码的域名）同样失败，`main` 分支当时也已全红。
2. **生产新装/换机部署会失败**：`docker-compose.prod.yml` 钉的 `minio/minio@sha256:d051…`、`minio/mc@sha256:eb4e…` 已不可拉取；运行中的实例因本地有镜像缓存，暂时没有暴露。
3. **`noj-cli` 备份路径的 mc 镜像失效**：`MINIO_CLIENT_IMAGE = minio/mc:latest@sha256:a7fe…` 同样拉不到（无缓存主机上备份会失败）。

## Decision

统一改用 **Bitnami 冻结镜像源**，并保持 MinIO 版本不漂移：

- `docker-compose.e2e.yml` / `docker-compose.yml`：`bitnamilegacy/minio:2024.11.7-debian-12-r2`、`bitnamilegacy/minio-client:2025.7.21-debian-12-r3`（该 minio 镜像同时内置 `minio` 与 `mc`）。
- `docker-compose.prod.yml`：同源并**按多架构 manifest list 钉 digest**
  （minio `sha256:81cd091f…13d6`、minio-client `sha256:73bd39f7…c158`）。
- **prod 的 minio 以 `user: "0"` 启动**：Bitnami 入口脚本会在 root 下 `chown -R minio` 数据目录，再把服务降权到 `minio` 用户运行（`libminio.sh` 的 `minio_initialize`）。这既是该镜像的标准用法，也是**存量升级的自愈路径**。
- 数据目录随镜像改为 Bitnami 约定 `/bitnami/minio/data`（卷内容不变，仅挂载点变化）。
- **prod 的 `minio-init` 脚本改为 POSIX sh 兼容**：原实现用 bash 专有的 `${policy//__S3_BUCKET__/${S3_BUCKET}}` 做策略模板替换，而官方 mc 镜像的 `/bin/sh` 是 bash、Bitnami（Debian）的是 **dash**，换镜像后会以 `Bad substitution` 失败，导致 bucket/策略/应用用户全部没建、core 无法使用 S3。改为 `sed "s/__S3_BUCKET__/${S3_BUCKET}/g"`。
- `noj-cli` 的 `MINIO_CLIENT_IMAGE` 同步换为新 digest（该常量目前无调用方：备份实际执行的是 `docker compose run … minio-init`，保留常量供预检/离线场景）。

## Alternatives considered

- **继续用官方镜像 + 重试/换 registry**：仓库已被删除、二进制返回 410，无从拉取。
- **自建 minio 镜像**：官方二进制同样下架（`dl.min.io` 410），没有可信来源。
- **迁移到托管 S3（阿里云 OSS / R2 等）**：长期更稳（不依赖冻结镜像源），但属产品/运维决策，且要改 `S3_*` 配置、文档与存量数据迁移，未在本次范围内做出。
- **只修 CI、不动 prod 与 CLI**：会让"新装必失败"这件事继续留在仓库里，故一并修复。
- **prod 不设 `user: "0"`、改为文档要求手工 chown**：需要运维在每个存量实例上手工执行，且漏做即容器崩溃重启循环；选择让入口脚本自愈。

## Consequences

- 三处（e2e / dev / prod）与 CLI 常量统一到同一镜像来源，MinIO 版本保持 RELEASE.2024-11-07。
- **已实测**（本地真实容器，非推断）：
  - 升级路径：旧镜像写下的 root 属主数据卷 → 新镜像 `user: "0"` 启动后**数据完好**（桶与对象读回一致）、属主被入口自动 chown、服务进程以 `minio` 用户运行；
  - 初始化链路：新 mc + 新 server 下建桶 / 建策略 / 关联策略 / 建应用用户全部成功，应用凭据可读写自身 bucket、跨 bucket 访问被拒（最小权限保持）；
  - dev/e2e 变体：健康检查通过、`minio-init` 建桶成功、对象读写往返正常、卷挂载重启后数据仍在。
- `bitnamilegacy` 是**冻结**命名空间（不再更新、无安全公告），适合作为可复现的测试/过渡依赖；**长期建议评估迁移到受支持的托管 S3**（另开决策）。
- `docker-compose.prod.yml` 是发布资产：改它需要**发一个新 release**，`noj-cli install/update` 才会拿到新镜像引用。
- 仓库内的 YAML/文档若再引用 `minio/minio`、`minio/mc`、`quay.io/minio/*`，一律视为失效引用。
