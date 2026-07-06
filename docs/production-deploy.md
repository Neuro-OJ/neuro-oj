# Neuro OJ — 生产部署运维指南

本文档针对 `docker-compose.prod.yml` 编排的整套生产栈（nginx 反代 + 三个应用 + PostgreSQL + Redis + Certbot）。目标是把这份栈部署到一台面向公网的 Linux 服务器。

## 目录

1. [前置条件](#前置条件)
2. [首次部署](#首次部署)
3. [dev vs prod 差异](#dev-vs-prod-差异)
4. [运维操作](#运维操作)
5. [已知限制与前置依赖](#已知限制与前置依赖)

---

## 前置条件

### 硬件

- 单台 Linux 服务器（Ubuntu 22.04 LTS / Debian 12 推荐）
- 至少 4 核 CPU + 8 GB RAM + 50 GB SSD
- 公网 IPv4，80 / 443 端口可访问

### 软件

- Docker Engine 24+
- Docker Compose v2（`docker compose version` ≥ 2.20）
- 域名已配置 DNS A 记录指向服务器公网 IP

### 文件清单（git 仓库内）

```
docker-compose.prod.yml                 # 主编排
docker/nginx/                            # 反代配置
noj-core/Dockerfile.prod
noj-ui/Dockerfile.prod
noj-judge/Dockerfile.prod
scripts/init-letsencrypt.sh              # 首次部署
scripts/prod-renew-cert.sh               # 证书续期（cron 用）
scripts/prod-backup.sh                   # DB 备份
scripts/prod-restore.sh                  # DB 恢复
env.prod.example                         # 环境变量模板
```

---

## 首次部署

### 1. 拷贝 + 配置 env

```bash
cp env.prod.example env.prod.sh
$EDITOR env.prod.sh
```

按标注填必填项：

```bash
POSTGRES_PASSWORD=<openssl rand -base64 32>
JWT_SECRET=<openssl rand -base64 32>
YOUR_DOMAIN=jnoj.example.com
LE_EMAIL=admin@example.com
ADMIN_EMAIL=admin@example.com
ADMIN_PASS=<your secure password>
```

### 2. 签发 TLS 证书

```bash
bash scripts/init-letsencrypt.sh
```

脚本会：
1. 用临时 nginx 配置（仅 80 端口）启动
2. certbot webroot 签发证书
3. 切回完整配置（含 443 / 限流 / 反代）
4. 自动 reload nginx

### 3. 启动完整栈

```bash
docker compose -f docker-compose.prod.yml up -d
```

验证：

```bash
curl -fsSL https://$YOUR_DOMAIN/health         # 应返回 healthy
docker compose -f docker-compose.prod.yml ps   # 所有服务 healthy
```

### 4. 首次登录

用 `env.prod.sh` 中的 `ADMIN_EMAIL` / `ADMIN_PASS` 登录，首次登录强制改密。

---

## dev vs prod 差异

| 维度 | dev (`docker compose up`) | prod (`-f docker-compose.prod.yml`) |
|------|---------------------------|--------------------------------------|
| 端口 | 6379 / 5432 直连 | 仅 80 / 443 经反代 |
| CORS | `*`（开发允许） | 白名单必填，否则跨域拒绝 |
| TLS | 无 | Let's Encrypt + 宿主机 cron 续期 |
| 日志 | docker 默认 | json-file + 100MB × 5 轮转 |
| 资源限制 | 无 | CPU / Memory limit 全栈 |
| DB / Redis | 容器化同名 | 卷命名 + 强密码 + 健康检查 |
| seed | 自动运行 + 临时引导管理员 | 用 `ADMIN_EMAIL` / `ADMIN_PASS` 显式引导 |
| 备份 | 无 | `prod-backup.sh` 定时 |

---

## 运维操作

### 查看状态

```bash
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs --tail=50 -f core
curl -s https://$YOUR_DOMAIN/health | jq
```

### 备份 DB

```bash
# 手动单次备份
docker compose -f docker-compose.prod.yml exec postgres /usr/local/bin/backup.sh

# 输出：/var/backups/noj-backup-YYYYMMDD-HHMMSS.tar.gz（命名卷 backup_data）
# 默认保留 30 天（BACKUP_RETENTION_DAYS 可调）

# 拷贝到外部存储（示例：S3）
aws s3 cp /var/backups/noj-backup-*.tar.gz s3://my-noj-backups/$(date +%Y/%m/%d)/
```

### 恢复 DB

```bash
# 把备份 tar.gz 拷回宿主机 /var/backups/ 后：
./scripts/prod-restore.sh /var/backups/noj-backup-20260101-120000.tar.gz
```

### 证书续期

⚠️ **`certbot` 服务是 `profiles: ["certbot"]` 的工具容器，无长驻进程，不会自动续期。** 续期必须由宿主机 cron / systemd timer 调用 `scripts/prod-renew-cert.sh` 完成。

**一键安装（systemd timer，优先）**：

```bash
sudo ./scripts/install-backup-cron.sh --with-cert-renew
# 启用：备份每日 03:00 / 续期每日 03:30 各 ±5min 随机延迟
systemctl list-timers
```

**或手动配置 crontab**：

```cron
# /etc/cron.d/noj-cert-renew
30 3 * * * root /opt/noj/scripts/prod-renew-cert.sh >> /var/log/noj-cert-renew.log 2>&1
```

**立即手动续期**：

```bash
bash scripts/prod-renew-cert.sh
```

续期脚本本身检测到证书未到窗口不会 reload nginx；只有实际续期时才触发 `nginx -s reload`。

### 优雅重启（依赖 #107）

```bash
docker compose -f docker-compose.prod.yml restart core
```

⚠ 当前 PR 之前，noj-core / noj-judge 不响应 SIGTERM，rebuild 期间可能有正在进行的任务被打断；合并 #107 后即可干净退出。

### 扩缩容

**垂直**：调 `docker-compose.prod.yml` 各服务 `deploy.resources.limits` 后 `docker compose up -d`。

**水平**：

PR 默认 `core` / `ui` / `judge` 三者 `replicas: 2`。两种扩展方式：

- **Swarm 模式**（推荐生产多机）：
  ```bash
  docker swarm init
  docker stack deploy -c docker-compose.prod.yml noj
  # 扩缩容：
  docker service scale noj_core=4 noj_judge=6
  ```
  swarm 自动用 internal DNS + IPVS 做负载均衡，nginx `upstream core:8000` 无需改动即可 round-robin 到所有实例。

- **单机 compose**（`deploy.replicas` 在此模式被忽略，需用 `--scale`）：
  ```bash
  docker compose -f docker-compose.prod.yml up -d --scale core=4 --scale judge=6
  ```
  ⚠️ `--scale` 模式下 nginx 需要走 Docker 内置 DNS resolver 才能 round-robin 到多个实例
  （已配置 `resolver 127.0.0.11 valid=10s;` + `server core:8000 resolve;`）。

- `nginx` 因 80/443 端口冲突需改用云 LB（ALB / NLB）前置
- `postgres` / `redis` 不建议本机多实例，应迁移到托管服务

### 升级应用

```bash
git pull
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d
```

迁移会自动跑（main.ts 内置 startup sequence）。

---

## 已知限制与前置依赖

### #107（SIGTERM + /health）

合并前：
- `docker compose stop` 对 core / judge 容器不生效 `stop_grace_period`，直接 KILL
- 后台 consumer / RPC handler / pubsub subscriber 不会干净关闭
- 可能存在 MQ 连接残留（Redis 端感知到异常断开，无数据丢失）

合并后：
- `stop_grace_period` 完全生效，MQ 连接干净关闭

### #97 / #98（S3 存储）

支持包当前落本地 `/tmp/noj-work` 卷，多实例部署需迁移到对象存储。issue #97 已开。

### #101（审计日志）

管理后台系统设置变更（issue #99）已写到 stdout 日志前缀 `[admin]`；完整审计日志表落地是 #101。

### 评测资源争抢

`judge` 容器与 `nginx` / `core` 共享 docker.sock 与宿主机资源。大型评测任务可能抢占本机 CPU，影响前端响应。建议：

- 单机部署 → 限制 judge `MAX_CONCURRENT=2`
- 集群部署 → judge 拆到独立节点
