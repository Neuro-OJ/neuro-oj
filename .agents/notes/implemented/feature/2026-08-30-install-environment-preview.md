# Agent Note: 安装前展示环境要求与主机状态

Status: implemented

## Problem

生产安装在获取 Release、下载源码和写入目标目录前缺少统一的环境预览，用户通常只能在中途失败后才知道主机缺少什么。原有摘要也没有展示 CPU、Swap 和 Docker 存储目录所在磁盘。

## Decision

让 bootstrap 的 `check_host` 在开头输出按项目最低要求整理的环境清单，并展示当前主机的 Linux/架构、CPU、内存、Swap、目标磁盘、Docker 存储磁盘、基础工具、Docker/Compose 和端口状态。`install` 在 Release 查询和源码下载前调用同一入口；资源统计无法读取时明确提示并安全降级，不因此伪造结果或扩大资源阻断范围。

## Alternatives considered

- 只在安装失败后输出环境信息：实现简单，但用户需要经历一次失败才能获得诊断，且可能已经产生下载或目录副作用。
- 单独新增一套 install 检查逻辑：可以定制安装输出，但容易与 `check` 命令产生不一致，长期维护成本更高。
- 将最低 CPU、内存和磁盘要求全部作为硬门禁：可以更早阻止低配主机，但容器运行时和宿主机统计可能存在差异，当前需求只要求展示，强制门禁应另行评估。

## Consequences

首次安装和独立 `check` 都会先显示要求与当前环境，主机问题能在网络 Release 查询和源码下载前被发现。输出会略有增加；Deno、Rust、Node.js 等开发工具仍不会被误列为生产安装必需依赖。
