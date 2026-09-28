# 前置冻结与基线快照（2026-09-28 无人值守会话）

> 本文件是 spec §8 要求的 `baseline.md`：记录锚点、环境、基线快照与**环境事故**。
> 会话窗口：2026-09-28 22:00 → 2026-09-29 07:00（CST）。

## 1. 版本控制锚点

| 项 | 值 |
|---|---|
| 会话开始（执行） | 2026-09-28 21:44:53 CST |
| `origin/main`（冻结） | `6dbdd76b57d7d23ee776a292aebd9a1a8ece0511` |
| `jj` `main` bookmark（冻结） | `qrsktulv 6dbdd76b` |
| 栈基（原 `e515aafb`，消息规范化后） | `nxzkymvq 4356fe1814b23106c6b25065faed5b9f92b755f4` |
| 栈基树 hash（**规范化消息前后未变**） | `2d1f2013297cb8af8ed537a04759e31b736c30b7`（48 文件） |
| 栈基签名 | `%G? = G`（有效） |
| 栈基 Draft PR | [#593](https://github.com/Neuro-OJ/neuro-oj/pull/593)（base `main`，head `style/cyber-azure-tokens`） |
| `@`（工作副本） | `rvknsxto` |

### 栈基处置记录（经 Owner 确认）

- `e515aafb` 是 Owner 2026-09-28 20:55 的本地工作（跨站配色对齐 noj-docs 浅蓝科技调，48 文件），
  **原提交消息为空**，Owner 于 21:31 自行 `jj describe -m "ui refactor"`。
- 经 Owner 确认规范化为 `style(ui,root): 全站配色对齐 noj-docs 浅蓝科技调并同步设计 token 规范`；
  **内容零改动**（树 hash 前后一致）、签名有效、48 文件不变。
- 同时发现一个**孤儿 head** `676aafb3`（Owner 20:27 的更早一版 endfield 风格 UI 重设计，非 `@` 祖先、已被取代）；
  经 Owner 确认 `jj abandon` 清除（op log 仍可 `jj op restore` 找回）。

## 2. 环境与工具链

| 项 | 值 |
|---|---|
| Deno | `2.9.7`（V8 15.0.245.2-rusty / TypeScript 6.0.3） |
| Rust | `cargo 1.99.0-nightly` / `rustc 1.99.0-nightly` |
| Node | `v26.9.0` |
| `gh` 认证 | `hachimi-ak-ioi`（scopes: gist, read:org, repo, workflow） |
| GPG | `jj signing.sign-all = true`、`signing.behavior = "own"`、key `F2228B681060D92532F4528974E9300535E7C223`（私钥存在）；提交验证 `%G? = G` |
| 基础设施 | `noj-postgres`(5432) / `noj-redis`(6379) / `noj-minio`(9000-9001) / `noj-llm-gateway`(8001) 全部在线 |
| judge 二进制 | **会话开始前为 9-11 构建（10020040 B，早于 9-28 沙箱加固）**，已在本会话 21:52:43 重建为 `10058352 B` |
| `noj-eval-net` | 会话开始时**不存在**；由（失败的）e2e 启动尝试创建，现存在 |
| 评测镜像 | `noj-evaluator-python:latest` / `noj-solution-python:latest` 存在（旧构建，**未按当前工作树重建**） |

## 3. 环境约束（本会话新发现，影响所有验证）

**会话文件沙箱把工作区之外全部置为只读**，而 Deno 与 Docker 都需要写 `$HOME`：

| 路径 | 状态 |
|---|---|
| `/home/sakura-madoromi`（`$HOME`，含 `~/.cache/deno` 4.8G、`~/.docker`） | **只读** |
| `/tmp` | 可写，**tmpfs 14G**（内存盘；当时可用内存约 10G） |
| `/var/tmp`、`/run`、`/home/xyber-nova` | 只读 |
| 工作区 `/home/xyber-nova/Github/neuro-oj` | 可写（btrfs，166G 可用） |

**绕行方案（本会话全程使用，已在 final-report 中列为可复现步骤）**：

1. `DENO_DIR=<repo>/node_modules/.deno_cache`
   - 直接现象：不设置时任何**未缓存**依赖都会 `Failed caching https://jsr.io/...` 而失败
     （jsr.io 实测 HTTP 200 可达，**不是网络问题**）。
   - 位置选择有讲究：`.deno_cache/` 虽在 `.gitignore` 且被多数门禁跳过，但
     **`scripts/verify-md-links.ts` 只跳过 `node_modules`、不跳过 `.deno_cache`** —— 把缓存放在
     仓库根时 `check-all` 会因扫描缓存内的 README 报出 **5560 条 md-links 错误**（纯属自造的假红）。
     放在 `node_modules/.deno_cache` 下则所有门禁都跳过它。
   - 缓存用 `cp -r` 复制（4.8G，**8 秒**）；硬链接不可用（`$HOME` 与工作区属不同 btrfs 子卷，
     `cp -al` 报 `无效的跨设备链接`）。
2. `DOCKER_CONFIG=/tmp/docker-cfg`（复制 `~/.docker` 内容后覆盖）
   - 直接现象：不设置时 SDK 镜像构建全部失败 ——
     `failed to update builder last activity time: open /home/sakura-madoromi/.docker/buildx/activity/...: read-only file system`。
   - 验证：`docker buildx ls` 正常、试构建返回 sha256。

## 4. 环境事故：dev 基础设施被 e2e 启动脚本"接管"（已修复，数据无损）

**这是本会话最严重的环境损伤，Owner 必须知晓。**

- **触发**：执行 `bash scripts/e2e/setup.sh`（为 faces 1.2/1.3 准备 `noj-eval-net` 与评测栈）。
- **根因**：`docker-compose.e2e.yml` 与 `docker-compose.yml` **共用同一个 compose 项目名
  `neuro-oj`**（脚本调用 `docker compose -f docker-compose.e2e.yml up -d --build` **未传 `-p`**），
  两份文件都有 `postgres` / `redis` / `minio` 服务 → compose 把它们当作同一项目的同一服务
  **重建**，dev 的 `noj-postgres` / `noj-redis` / `noj-minio` 被替换为 `noj-e2e-*`，随后因
  容器名冲突（旧的 `noj-e2e-*` 已存在）报错退出。
- **修复**：`docker compose -f docker-compose.yml up -d` 恢复 dev 三件套；
  实测 `5432 / 6379 / 9000 / 8001` 全部 OPEN，容器 `Up`。
- **数据无损的证据**：三个数据卷**未被重建** ——
  `neuro-oj_postgres-data` / `neuro-oj_redis-data` 创建于 `2026-06-30T08:19:36`，
  `neuro-oj_minio-data` 创建于 `2026-07-03T16:48:54`，均远早于本会话；容器重建不销毁卷。
  恢复后连通性复核：`noj-postgres` 查询返回 `problems=0 | users=1 | contests=0`。
- **遗留清理**：由该次失败产生的 `Created` 状态容器（`noj-e2e-minio` / `noj-e2e-llm-mock` 等）已删除；
  6 天前就处于 `Exited` 状态的旧 `noj-e2e-*` 容器（属另一 compose 项目 `noj-e2e`）保留未动。
- **这是仓库的真实缺陷**（不是环境问题）：`scripts/e2e/setup.sh` 缺少独立项目名，任何人在
  dev 基础设施运行期间执行它都会踩到同一脚印。列为面 1.3 / 面 8 的候选 finding（本轮未修）。

## 5. 门禁与测试基线

| 项 | 结果 |
|---|---|
| 首次 `check-all`（缓存误放仓库根） | **EXIT=1，5560 条 `verify-md-links` 错误全部来自 `.deno_cache/`** —— 属本会话自造的假红，非仓库问题 |
| 迁移缓存后 `check-all` | 见 `logs/check-all-final.txt`（本次运行的 `CHECK_ALL_EXIT` 记录在文件末行） |
| judge `cargo fmt --check` | 修复后通过 |
| judge `cargo clippy --all-targets -- -D warnings` | 见 `logs/` / 本节末尾实测 |
| judge `cargo nextest run --all-targets`（`REDIS_URL` 指向 dev Redis DB 9） | 见 `logs/` 与 final-report |
| judge lib 单测 | `190 passed / 0 failed` |
| Redis 相关集成测试 | `user_claim_redis` 8 passed（含 1 条新增）、`requeue_redis` 1 passed（新增） |

> 基线判读口径：本会话**未能**取得"改动前的干净全量绿基线"（首次运行即被上述假红污染），
> 因此"不回归既有测试"的证据以**改动后各套件全绿 + 与失败清单对照**给出，而非"失败数不增加"。
> 这是本轮取证的一处**强度不足**，已记入 final-report 的待改进项。

## 6. 未完成的前置项（诚实记录）

- **e2e 栈未启动**：因上述事故后不再使用 `scripts/e2e/setup.sh`；judge 的 Redis 依赖测试改用
  dev Redis（`redis://127.0.0.1:6379/9`，独立 DB，不污染 DB 0）。
- **评测镜像未按当前工作树重建**：`noj-evaluator-python:latest` 等仍是旧构建，digest 未记录。
  任何依赖真实容器的结论（容器逃逸实测、`NOJ_RUN_E2E=1` 的 Docker E2E）本轮**均未取证**。
- **`cargo build --release` 重建过 judge 二进制**，但本轮的单元/集成测试跑的是 debug 构建。
