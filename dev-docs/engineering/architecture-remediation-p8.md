# 架构整治 P8：协调发布、旧路退役与隔离恢复演练

本文记录 P8 已落地的运行合同。P8 关注的是跨模块发布边界，不改变 Core、Judge、
Gateway 的业务所有权；生产升级仍必须由维护窗口和经过审阅的发布操作执行。

## 发布集合同

每个生产 Release 必须同时发布：

- `release-set.json`；
- `release-set.json.sha256`；
- 与发布集同版本的 CLI、Compose 和环境模板资产。

`release-set.json` 的 `schema_version` 为 `1`，固定记录七个组件的完整镜像路径和
`sha256` digest：Core、UI、Judge、Gateway、Evaluator、Python Solution、AI Solution。
同时记录：

- `migration_level`（当前 Core/Gateway 迁移前缀）；
- `protocol_versions.evaluation = 3` 与 `protocol_versions.gateway = 3`；
- 与 Release tag 一致的 `cli_version` 和 `ide_version`；
- `sdk_standard = noj-wasm-v1`。

Release workflow 先消费 `verify-release` 产出的 `release-<image>.txt`（镜像路径、版本、
digest 三列），再由 `scripts/release/generate-release-set.ts` 生成发布集，并上传 SHA-256
校验文件。CLI 只接受 SHA-256 正确、目标 tag 一致且所有启用组件 digest 与发布集一致的
资产；同一份经过校验的对象贯穿拉取、验签、迁移和启动，不能以“重新解析 Compose”替代。

## 升级顺序与 checkpoint

`noj-cli update` 的阶段是单调的：

```text
resolved -> backed_up -> pulled -> verified -> draining -> migrating -> started -> completed
                                             \-> failed
```

checkpoint 位于安装目录的 `backups/upgrade-state.json`，以临时文件 + rename 原子写入，
权限为 `0600`，不保存口令、token 或环境变量。固定顺序如下：

1. 解析并校验目标发布集、配置、磁盘空间和备份能力；
2. 创建并验证升级前备份；
3. 拉取目标资产并按发布集验签；
4. 进入维护/排空，等待已受理任务和结果 fallback 完成；
5. 停止服务，按发布集中的迁移级别执行 Core 与 Gateway 迁移；
6. 启动同一发布集，检查健康状态与依赖；
7. 完成 checkpoint，并解除维护状态。

中断后必须显式使用 `noj-cli update --recover`。迁移前失败保留旧发布集；迁移后失败
保持维护状态，恢复路径是同一份备份和同一份发布集合同的恢复流程，不能只把镜像 tag
换回旧版本。`failed` 和 `completed` 均为终态，不能被普通路径静默改写。

## 默认域旧写入路由退役

生产 Core 默认启用 `noj-core/src/modules/http/retired-endpoints.json`。表中旧的默认域
写入/执行路径由 `retiredEndpointMiddleware` 返回 HTTP `410`，响应包含：

```json
{
  "code": "ENDPOINT_RETIRED",
  "replacement": "显式域路由",
  "request_id": "..."
}
```

只拦截表中列出的 method + path，不影响同路径 GET；测试组合根可以显式关闭或开启该门禁。
Web UI 的旧默认入口由 `default-workspace.global.ts` 重定向到 `/d/:slug`，业务 API
仍要求 URL 中携带显式域；LMCC 扩展提交代码也使用
`POST /api/v1/domains/:slug/submissions`，不再依赖根级提交端点。

## 隔离恢复演练

`noj-cli backup drill` 是真实 Compose 恢复与业务验收，不是文件完整性检查。它必须：

- 显式连接专用 Docker daemon 的 Unix socket；默认 `/var/run/docker.sock` 和
  `/run/docker.sock` 会被拒绝；
- 每次使用唯一 Compose project、唯一子网和独立数据根；
- 不继承生产宿主机端口映射；
- 失败时执行 `compose down -v --remove-orphans`，除非操作员传 `--keep`；
- 用 `--rpo-max-hours` / `--rto-max-minutes` 判定报告是否通过。

推荐的操作形态是在专用维护主机上启动 rootless 或独立 systemd Docker daemon。示例中
`run`、`sock`、`root` 必须是本次演练新生成的值，不能指向默认 daemon：

```bash
run="$(date -u +%Y%m%d-%H%M%S)-restore"
sock="/run/noj-restore-drill/$run/docker.sock"
root="/var/lib/noj-restore-drill/$run"

# 由维护主机的 rootless/systemd daemon 管理器启动；下面仅示意隔离参数。
# 不要把 --host 改成 /var/run/docker.sock，也不要复用生产 data-root。
dockerd \
  --data-root "$root" \
  --exec-root "$root/exec" \
  --pidfile "$root/docker.pid" \
  --host "unix://$sock" \
  --bridge "noj-restore-drill-$run"

NOJ_DRILL_DOCKER_HOST="unix://$sock" \
  noj-cli backup drill /srv/noj/backups/example.nojbackup \
    --dir /srv/noj \
    --docker-host "unix://$sock" \
    --rpo-max-hours 24 \
    --rto-max-minutes 60
```

实际启动 daemon 时必须由维护主机确认 rootless/containerd、权限、socket 目录和清理策略；
上面的 CLI 会再次执行 host 校验和 `docker info` 探测。演练报告、Compose 项目名、数据卷
和指标文件必须作为本次 run 的验收证据保存，清理时只删除该 run 的专用 data-root、
socket 和 project。

本轮没有连接默认 Docker daemon；默认 daemon 上存在其他开发/生产样容器。为取得真实
Compose 证据，本轮在临时专用 rootless daemon 上完成了 `backup drill --skip-judge --keep`：
PostgreSQL、Redis、MinIO 恢复，迁移版本/快照/用户数/Redis 键数/对象数核对，Core 与
Gateway 迁移初始化，以及隔离 Core HTTP 上的登录、题目读取和摘要业务验收均通过。
演练结束后仅清理本轮临时 daemon、socket、数据根和 Compose 项目。

完整 Judge 业务链另行尝试过：Judge 镜像和数据服务能够在该专用 daemon 启动，但 rootless
slirp 网络不提供宿主机到容器 IP 的路由，宿主侧 verifier 因此收到 `No route to host`。
这部分不计为完整 Judge 用户旅程通过，也不把 `--skip-judge` 证据冒充为 Judge 评测证据。

## 验收证据边界

以下证据分别记录，不互相冒充：

- 发布集生成/校验：纯函数、CLI 单测和供应链脚本；
- 升级恢复：checkpoint 单测与 CLI 生产测试；
- 恢复演练：隔离 Docker daemon 上的真实 Compose、数据库/Redis/MinIO 恢复和
  `--skip-judge` 业务 HTTP 验收已通过；完整 Judge 业务链因 rootless 宿主路由限制未宣称通过；
- 正常用户旅程/浏览器：必须另行在独立 UI/Core 环境通过浏览器验收。

本轮未操作生产环境，也未操作默认 Docker daemon、默认 PostgreSQL、Redis 或 MinIO。
