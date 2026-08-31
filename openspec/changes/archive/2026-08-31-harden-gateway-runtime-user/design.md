## Context

`noj-llm-gateway` 基于 Alpine Deno 镜像构建，当前 Dockerfile 没有覆盖基础镜像默认用户，因此正式验证中的非 root smoke test 在网关镜像上失败。其他生产镜像已经使用专用用户，网关应保持一致。

## Goals / Non-Goals

**Goals:**

- 在网关运行时创建专用用户并切换到该用户。
- 确保 `/app` 中已复制的运行文件可以被该用户读取。
- 让现有发布 smoke test 验证网关的非 root 运行状态。

**Non-Goals:**

- 不改变 Deno 版本、端口、启动参数或网关代码。
- 不修改容器编译阶段的权限模型。
- 不放宽发布验证中的非 root 要求。

## Decisions

- 使用 Alpine 自带的 `addgroup` / `adduser` 创建固定 UID 的专用用户，并在 Dockerfile 中声明 `USER`。这样不需要新增软件包，镜像变化小且与其他生产镜像的固定 UID 约定一致。
- 在切换用户前将 `/app` 的所有权设置给专用用户。相比仅依赖默认文件权限，这能明确保证未来复制的运行文件仍可被网关读取。
- 保留现有 `command -v deno` smoke test，并由容器运行时用户检查覆盖 root 回归。

## Risks / Trade-offs

- [应用运行时需要写入 `/app`] → 当前网关为服务进程读取源码和依赖，不依赖 `/app` 写入；若未来需要写入，应使用单独的可写数据目录并显式授权。
- [基础镜像用户实现变化] → 使用 Alpine 标准命令和固定 UID，并在 Release workflow 中执行真实容器 smoke test。

## Migration Plan

1. 修改网关 Dockerfile，创建专用用户、设置目录权限并声明运行用户。
2. 运行 Dockerfile 相关静态检查和 OpenSpec 校验。
3. 合并后重新创建 RC，确认网关镜像 smoke test 及整个正式发布验证通过。
4. 若出现权限问题，回退 Dockerfile 变更；不会影响已存在的镜像标签。
