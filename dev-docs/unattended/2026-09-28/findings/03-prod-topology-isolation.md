# 面 1.3 — root / compose 生产拓扑隔离（实测报告）

> 审计面：生产拓扑隔离 ｜ 类型：II 二次审计 ｜ 时间：2026-09-29 08:2x
> 方式：**真实 Docker 实测 + 生产 compose 读证**（本面不需要 e2e 栈——见文末"为何不用 `scripts/e2e/setup.sh`"）
> 证据：`evidence/03-network-isolation-probe.txt`、`evidence/01-judge-docker-e2e.txt`

## 1. 生产端口暴露矩阵（`docker-compose.prod.yml` 全量）

`ports:` 段**只有三处**：

| 服务 | 映射 | 绑定面 | 裁定 |
|---|---|---|---|
| `nginx` | `${NGINX_PORT:-8080}:80` | 0.0.0.0（默认） | ✅ 有意公开（平台入口；生产由外部 TLS 层/LB 承接） |
| `prometheus` | `${PROMETHEUS_BIND:-127.0.0.1}:9090` | **仅回环** | ✅ 不可被容器经网关触达 |
| `alertmanager` | `${ALERTMANAGER_BIND:-127.0.0.1}:9093` | **仅回环** | ✅ 同上 |

**postgres / redis / minio / core / llm-gateway / judge 均无 `ports:` 段**（不发布任何端口）。

> 对比：**dev 的 `docker-compose.yml` 把 `5432/6379/9000/8001` 发布到 0.0.0.0**（本地开发需要）。
> 这个差异是本面一次**假阳性的成因**（见 §3）。

## 2. 隔离能力实测（真实容器）

| # | 断言 | 结果 | 证据 |
|---|---|---|---|
| 1 | 评测网络容器**按容器 IP** 无法到达其它网络的内网服务 | ✅ **BLOCKED**：`172.18.0.4:5432`（postgres）、`172.18.0.2:9000`（minio）均 `TimeoutError`（被网桥隔离丢弃） | `evidence/03-network-isolation-probe.txt` |
| 2 | 网络隔离 / 无敏感挂载 / 宿主边界（生产 HostConfig 构造器） | ✅ `e2e_security_isolation` **3 passed** | `evidence/01-judge-docker-e2e.txt` |
| 3 | tmpfs `noexec,nosuid,nodev` 在容器内实际生效 | ✅ 容器内 `mount` 实测 `rw,nosuid,nodev,noexec,relatime,size=262144k`；从 `/tmp` 执行投放二进制 `Permission denied`(126) | 同上 |
| 4 | Evaluator 沙箱仅可达允许目标（llm-gateway），**物理层**保证 | 🟡 **配置层确认、运行期未探针**：生产 compose 中 `llm-gateway` 是唯一双网卡服务（`noj-net` + `noj-eval-net`），其余服务只在 `noj-net`；本地 dev gateway 不在 `noj-eval-net` 上，故运行期探针需改动 dev 环境，本轮**未做** | `docker-compose.prod.yml:213-219,316,545-550` |

## 3. 一次被拦下的假阳性（本面最重要的方法论收获）

**现象**：从 `noj-eval-net` 内的探针容器**按容器名**连接 `noj-postgres` / `noj-redis` / `noj-minio`
以及 `172.17.0.1:5432` 全部 `REACHABLE`，DNS 也全部解析成功（`198.18.0.x`）。
若直接采信，结论会是"**评测隔离网络形同虚设，沙箱可直连内网数据库**"——一条Critical。

**实际是环境假象**，三步排查：
1. `docker inspect`：dev 的 postgres/redis/minio/gateway **只在 `neuro-oj_default`**；
   `docker network inspect noj-eval-net` 的容器列表为**空**（拓扑上不共享任何网络）。
2. 容器内 DNS：Docker 内部解析器的 ExtServers 为 `host(100.100.100.100)`、
   `search tailb83d19.ts.net` → **Tailscale MagicDNS**。
3. 同一容器内 `example.com` 被解析为 `198.18.0.10` → **fake-IP 透明代理标准段**
   （本机确有 `omniroute`）。代理按名接管并转发，**与 Docker 网络隔离无关**。

**判别实验（把两者分开）**：同一容器内

```
CONNECTED 172.23.0.1 5432 已发布 postgres
CONNECTED 172.23.0.1 9999 未监听端口      ← 未监听也能连 ⇒ 代理无差别接管
CONNECTED 172.17.0.1 5432 docker0:postgres
FAILED    172.17.0.1 9999 docker0:未监听  (ConnectionRefusedError) ← 真实路由
```

→ eval-net 网关路径不可作为证据；docker0 路径为真实路由，`5432` 通只因 **dev** 把端口发布到 0.0.0.0；
**生产不发布**，故生产不存在该路径。

**方法论规则（建议入库）**：**在带覆盖式 DNS / 透明代理的宿主机上，任何"按服务名可达性"的
安全结论都不可采信**；跨网隔离必须用**裸 IP** 验证，并用"未监听端口"作为对照。

## 4. 结论

- **生产拓扑隔离成立**（端口矩阵 + 按 IP 的路由隔离实测 + 生产 HostConfig 的容器级断言）。
- 该隔离依赖两条**前置条件**：① 宿主机不部署覆盖式 DNS/透明代理；② 内网服务不发布端口。
  建议在 judge 启动自检里加**主动断言**（"从评测网络内探测内网服务应失败，失败则拒绝启动"），
  把前置条件变成可验证的不变量，而不是文档约定。
- **未覆盖**：B6 的运行期探针（需生产式双网卡拓扑）；`--scale judge=N` 多副本共享 `WORK_DIR` 的
  实例标签冲突（见面 1.1 的 NOJ-A10，已在 `noj-judge/AGENTS.md` 标注）。

## 5. 为何不用 `scripts/e2e/setup.sh`（重要环境教训）

`scripts/e2e/setup.sh` 与 dev 共用 compose 项目名 `neuro-oj`（脚本未传 `-p`/`COMPOSE_PROJECT_NAME`），
而两边都有 `postgres`/`redis`/`minio` 服务 → 执行它会**把 dev 的 `noj-postgres/redis/minio` 重建为
`noj-e2e-*`**（本会话实际发生，已用 `docker compose -f docker-compose.yml up -d` 恢复；数据卷未被重建，
未丢数据）。**这是仓库真实缺陷**：脚本应固定独立项目名。

本面因此改用"**直接跑 judge 自己的 Docker E2E + 裸 `docker run` 探针**"的路径，效果更好且零副作用：
`NOJ_RUN_E2E=1 cargo test --test {e2e_security_isolation,e2e_support_package,e2e_abnormal,e2e_dual_container}`
合计 **27 passed / 0 failed**。
