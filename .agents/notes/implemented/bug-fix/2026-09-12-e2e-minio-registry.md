# Agent Note: 修复 E2E MinIO 镜像来源

Status: implemented

## Problem

E2E 的所有 Domain job 在共享前置阶段拉取 `minio/mc:RELEASE.2025-08-13T08-35-41Z` 时收到 Docker Hub `pull access denied`，导致测试未开始；独立 Judge Sandbox E2E 正常通过。Docker Hub 上的 `minio/minio` 与 `minio/mc` 仓库接口也已不可用。

## Decision

将 E2E Compose 中的 MinIO server 和 mc 客户端镜像统一切换到官方 Quay 仓库，保留已验证的版本标签：`quay.io/minio/minio:RELEASE.2024-11-07T00-52-20Z` 与 `quay.io/minio/mc:RELEASE.2025-08-13T08-35-41Z`。

## Alternatives considered

- 继续使用 Docker Hub 并重试：不能解决仓库接口返回 404/鉴权失败的问题。
- 使用 `latest`：会重新引入镜像漂移，无法保证 E2E 可复现。
- 自行构建 mc 镜像：增加构建链路和维护成本，且没有必要，官方 Quay 镜像已提供所需客户端。

## Consequences

E2E 不再依赖已失效的 Docker Hub MinIO 仓库，Compose 配置检查和启动脚本静态检查通过；推送后需等待 GitHub Actions 重新执行各 Domain E2E，确认镜像拉取和完整测试链路恢复。
