# Neuro OJ — 本地开发编排

> 本目录的 **`devtool.sh`** 是 Neuro OJ 本地开发编排工具，整合原 12 个独立脚本（`install-deps` / `start-{all,infra,core,ui,judge}` / `stop-{all,infra,core,ui,judge}` / `status`）为单入口，通过 5 个子命令分发。

---

## 快速开始（3 条命令）

```bash
# 1. 检测环境（自动安装 zip/unzip，提示其他依赖）
bash scripts/dev/devtool.sh install-deps

# 2. 准备环境变量（必填 DATABASE_URL 与 JWT_SECRET，至少 32 字符）
bash scripts/dev/devtool.sh init-env          # 默认拒绝覆盖；--merge 仅追加模板缺失键
$EDITOR noj-core/.env

# 3. 一键启动全部模块（infra → core → ui → judge）
bash scripts/dev/devtool.sh start
```

启动完成后访问：

- **前端**：<http://localhost:3000>
- **后端 API**：<http://localhost:8000>
- **健康检查**：`curl http://localhost:8000/health`

---

## 子命令清单

| 子命令 | 用途 | 关键 flag |
|--------|------|-----------|
| `install-deps` | 检测 / 安装 zip + Deno + Rust + Docker | `--check-only`（只检测不安装） |
| `init-env` | 初始化 `noj-core/.env`（默认拒绝覆盖） | `--merge`（追加模板缺失键）/ `--force`（覆盖） |
| `start [TARGET]` | 启动 TARGET（默认 all，按依赖顺序） | `--build`（judge 强制重编译） |
| `stop [TARGET]` | 停止 TARGET（默认 all，按反向依赖顺序） | — |
| `status` | 查看模块运行状态 | `--json` / `--watch SECS` |
| `help` | 显示帮助 | — |

`TARGET` 取值：`infra` / `core` / `ui` / `judge` / `all`（默认 `all`）。

---

## 常用组合

```bash
# 查看状态
bash scripts/dev/devtool.sh status
bash scripts/dev/devtool.sh status --json | python3 -m json.tool   # 结构化输出（CI 用）

# 单模块启停（适合纯前端 / 纯后端开发）
bash scripts/dev/devtool.sh start ui          # 只起前端
bash scripts/dev/devtool.sh stop  core        # 只停后端
bash scripts/dev/devtool.sh start judge --build   # 强制重编译 judge

# 优雅停止全部
bash scripts/dev/devtool.sh stop

# 更新模板并保留自定义配置
bash scripts/dev/devtool.sh init-env --merge
```

---

## 文件位置

| 文件 | 路径 |
|------|------|
| 编排入口 | `scripts/dev/devtool.sh` |
| 环境变量模板 | `scripts/dev/env.example` → `noj-core/.env` |
| PID 文件 | `scripts/dev/logs/<target>.pid` |
| 日志文件 | `scripts/dev/logs/<target>.log` |
| 同工具防双开锁 | `scripts/dev/locks/<target>.lock` |

---

## 平台支持

- **Linux**：原生支持（apt / dnf / pacman 自动装依赖）
- **macOS**：原生支持（brew 自动装依赖）
- **Windows**：请使用 WSL2（Docker Desktop 在 Windows 上必须 WSL2 backend，等同 Linux 环境）

---

## 国内开发环境：镜像与阈值调优

国内网络直连 crates.io / npmjs.org 经常出现"几十 KB 文件下载超时"、被 cargo / npm 误判为"传输过慢"。建议配置镜像 + 放宽阈值，否则首次 `start judge` 或 `npm install` 可能跑半小时才察觉是卡死。

### Cargo（noj-judge 编译）

新建 `~/.cargo/config.toml`：

```toml
# 用 TUNA 镜像替代 crates.io；sparse 协议对小文件响应更稳定
[source.crates-io]
replace-with = "tuna"

[source.tuna]
registry = "sparse+https://mirrors.tuna.tsinghua.edu.cn/crates.io-index/"

[registries.tuna]
index = "sparse+https://mirrors.tuna.tsinghua.edu.cn/crates.io-index/"

[net]
# git 协议拉取用系统 git（部分镜像不支持 git protocol）
git-fetch-with-cli = true
# 默认 http.timeout=30 / low-speed-limit=10 极易触发"spurious network error"
http.timeout = 300
http.low-speed-limit = 1
```

> 不调 `http.low-speed-limit` 时，cargo 在 TUNA 下会反复打 `warning: spurious network error (3 tries remaining): transfer too slow: failed to transfer more than 10 bytes in 30s`，看起来在下载实际上什么也下不动。

### npm（noj-ui 依赖）

新建 `~/.npmrc`：

```
registry=https://registry.npmmirror.com
```

Deno 的 `nodeModulesDir: auto` 会读 `~/.npmrc`；`deno task dev` 首次启动 Nuxt 时仍要数分钟下载 `@iconify-json/lucide` 等大包，属正常现象。

### PATH 持久化（macOS + brew rustup）

brew 安装的 `rustup` formula 不像 `rustup-init` 自动生成 `~/.cargo/bin` shim，需要手动软链并写入 shell rc：

```bash
mkdir -p ~/.cargo/bin
for tool in cargo rustc rustup rustfmt cargo-clippy clippy; do
  ln -sf "$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin/$tool" \
    "$HOME/.cargo/bin/$tool"
done
echo 'export PATH="$HOME/.cargo/bin:$PATH"' >> ~/.zshrc
```

---

## 故障排查

详细 FAQ 见：

- 仓库根 [`AGENTS.md` §14 故障排查速查](../../AGENTS.md#14-故障排查速查)
- 仓库根 [`README.md` §FAQ](../../README.md#faq)
- 子模块 `noj-core/CLAUDE.md` / `noj-ui/CLAUDE.md` / `noj-judge/CLAUDE.md` 的"关键安全措施 / 池内部常量 / 容器安全"段落

排查时常用：

```bash
# 看每个模块实时状态
bash scripts/dev/devtool.sh status

# 看具体模块日志
tail -f scripts/dev/logs/core.log
tail -f scripts/dev/logs/ui.log
tail -f scripts/dev/logs/judge.log

# 看 Redis 队列长度（队列堆积排查）
docker exec noj-redis redis-cli LLEN noj:judge:queue
```

如需前台运行某个模块（实时看日志、调试），仍可直接使用原生命令：

```bash
cd noj-core  && deno task dev
cd noj-ui    && deno task dev
cd noj-judge && cargo run
```

---

完整子命令列表与所有 flag：`bash scripts/dev/devtool.sh help`。