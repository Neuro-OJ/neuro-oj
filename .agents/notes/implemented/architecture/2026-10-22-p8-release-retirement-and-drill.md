# Agent Note: P8 发布集、旧接口退役与隔离恢复演练

Status: implemented

## Problem

Core、UI、Gateway、Judge、CLI 和生产部署资产缺少一个可验证的共同发布边界；升级过程
也需要把验签、迁移、排空和恢复状态固定下来。与此同时，默认域根级写入接口仍可能被
旧客户端调用，恢复演练若连接默认 Docker daemon 会把 `down -v` 的影响范围扩大到生产
或其他开发资源。

## Decision

引入 `release-set.json` 及 SHA-256 资产，固定组件 digest、迁移级别、协议 v3、CLI/IDE
版本和 SDK 标准；CLI 只使用同一份经校验发布集推进升级，并以原子 checkpoint 支持
显式 `--recover`。默认域写入/执行别名由显式清单驱动，生产默认返回 `410 ENDPOINT_RETIRED`，
保留替代路由和 request id。`backup drill` 必须显式连接路径带有
`noj-restore-drill` 的专用 Unix socket，自动生成唯一 project/subnet，并隔离 Compose
端口和数据根。

## Alternatives considered

- 继续按 Compose tag 解析并分别拉取镜像：无法证明组件来自同一发布集，拒绝。
- 迁移失败后只把镜像换回旧 tag：数据库迁移不可逆，不能保证旧程序可读，拒绝。
- 让恢复演练复用宿主默认 Docker socket：`down -v` 可能命中同名项目/数据卷，拒绝。
- 复用默认 daemon 完成演练：默认 daemon 已有其他资源，违反隔离边界，拒绝；本轮改用
  临时专用 rootless daemon，并保留真实演练的证据边界。

## Consequences

发布 workflow 需要先产出各镜像验签元数据，再生成并上传发布集；运维需要维护专用
Docker daemon，并把真实恢复演练记录为独立验收证据。旧客户端会得到可诊断的 410，而
显式域 UI/IDE 路径继续可用。本轮已在专用 rootless daemon 上通过真实 Compose 的
`--skip-judge` 恢复和业务验收；完整 Judge 业务链因宿主到 rootless 容器 IP 不可路由，
仅记录为未通过项，不扩大验收结论。
