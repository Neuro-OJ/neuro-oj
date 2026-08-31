## Context

现有 bootstrap 的 `check` 命令已经能检测部分 Linux、Docker、Compose、内存、磁盘和端口信息，但 `install` 路径只做了架构和 Docker/Compose 检查，且没有先向用户说明最低要求。安装脚本使用预构建镜像，主机不需要 Deno、Rust 或 Node.js。

## Goals / Non-Goals

**Goals:**

- 让 `install` 与 `check` 在同一套环境检测入口中输出最低要求和当前主机状态。
- 在网络 Release 查询、源码下载和目标目录写入之前阻断明显不满足条件的主机。
- 追加 CPU、Swap 和 Docker 数据根目录所在磁盘的可观测摘要。
- 不输出生产配置或其他敏感信息。

**Non-Goals:**

- 不改变最低资源阈值，也不把推荐配置强制变成阻断条件。
- 不自动安装 Docker Engine、Compose、Cosign 或 Judge 的 rootless Docker daemon。
- 不在安装前拉取业务镜像或启动容器。

## Decisions

### 复用 `check_host` 并在 install 中提前调用

将要求清单放在 `check_host` 的开头，使独立 `check` 和 `install` 使用相同输出；`install` 在架构快速检查后立即调用 `check_host`，通过后再查询 Release、检查目标目录和下载源码。这样不会产生第二套环境检测实现。

### 摘要当前值而不是扩大资源门禁

最低要求和当前检测值并列展示；现有检查失败项继续阻断安装，资源值先作为可读摘要，避免因容器宿主机内存、Swap 或 Docker 存储统计差异造成误判。磁盘分别展示目标目录所在文件系统和 Docker 数据根目录（可读取时）。

### 仅使用系统已有信息源

CPU 使用 `getconf`/`nproc`，内存和 Swap 使用 `/proc/meminfo`，磁盘使用 `df`，Docker 数据目录使用 `docker info`。不新增包管理器依赖，也不执行会改变系统状态的命令。

## Risks / Trade-offs

- [部分系统无法读取 Swap 或 Docker 数据目录] → 显示“无法读取”并保留已有的必要检查，不伪造数值。
- [安装输出变长] → 将要求清单和当前摘要集中在一个“安装前环境预览”区块，便于复制和查看。
- [资源摘要与实际容器可用资源不同] → 文档明确说明这是宿主机摘要，最终启动仍由 Docker/Compose 健康检查确认。

## Migration Plan

无需迁移。更新 bootstrap 后，新安装会自动显示预览；已有安装再次使用 `install.sh check` 时也会看到相同摘要。
