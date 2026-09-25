# Agent Note: 网关运行镜像混入构建期依赖，阻塞生产镜像发布

Status: implemented

## Problem

2026-09-25 发布 `v0.10.0` 时，Release Images 工作流的 `noj-llm-gateway` 矩阵任务在
Trivy 门禁（`severity: CRITICAL,HIGH` + `ignore-unfixed: true` + `exit-code: 1`）失败：

- 命中目标：`/app/node_modules/.deno/@esbuild+linux-x64@{0.18.20,0.25.12}/node_modules/@esbuild/linux-x64/bin/esbuild`
  被识别为 Go 二进制，分别报 27 与 22 项 HIGH/CRITICAL（`Total: 27 (HIGH: 25, CRITICAL: 2)` 等），
  如 CVE-2026-33814 / 33818 / 39820 / 39821 / 39822 / 56853 / 56862。
- 根因链：`noj-llm-gateway/deno.json` 的 `imports` 里登记了
  `"drizzle-kit": "npm:drizzle-kit@0.31.10"`（供 `drizzle.config.ts` 与 `db:generate`
  任务使用，`src/` 运行期**完全不引用**），而 `nodeModulesDir: "auto"` 会让 Deno 把
  import map 中的 npm 包**整棵树**装进 `/app/node_modules`；其传递依赖 `esbuild` 由 Go
  编写 → 49 项 HIGH/CRITICAL 被打进**运行**镜像。

影响面（比单镜像失败大得多）：`build-and-gate` 矩阵失败 →
`verify-release` / `publish-cli` / `publish-release` 全部不执行，于是：

1. 该镜像没有 `v0.10.0` 正式标签（只有未签名的 `v0.10.0-build.<run>.1`）；
2. Release **没有** `noj-cli-linux-amd64` 二进制，也**没有**
   `docker-compose.prod.yml` / `.env.prod.example` 资产；
3. 而 `noj-cli install` 第 1 步会**无条件**从同版本 Release 下载后两者并校验 SHA-256
   （`noj-cli/src/prod/bootstrap.ts` 的 `RELEASE_FILES`）→ **任何版本、任何 ref 的
   `install` 都会在 bootstrap 步骤 404**。`v0.9.5` 的 Release 缺同样资产，是同一个原因
   （那次 workflow run 亦为 `failure`）。

## Decision

**把 `drizzle-kit` 移出运行期依赖图**，而不是在 Dockerfile 里"剪掉"文件：

- `noj-llm-gateway/deno.json`：删除 `imports` 中的 `"drizzle-kit"` 条目；
- `noj-llm-gateway/drizzle.config.ts`：`from "drizzle-kit"` →
  `from "npm:drizzle-kit@0.31.10"`（与 `db:generate` 任务里既有的写法一致）。

`deno.lock` 无需改动：已在固定版本 deno（`denoland/deno:alpine-2.9.5`）容器内验证
`deno cache --lock=deno.lock drizzle.config.ts` 与现有 lock 一致（0 行差异）。

本地实证（同一 Dockerfile，未做任何剪枝）：

| 验证项 | 结果 |
| --- | --- |
| 镜像内 Go 二进制（`go1.x` 标记扫描） | **0 个** |
| `/app/node_modules` 内容 | 仅 `drizzle-orm` / `hono` / `ioredis` / `postgres` |
| Trivy 同参数复扫 | **退出码 0**，输出无 CVE 提及 |
| `--network none` 启动 | **无任何 `Download` 行**，直接进入 Redis/DB 连接失败路径 |
| 镜像体积 | 432 MB → **254 MB** |

## Alternatives considered

1. **在 Dockerfile 里 `rm -rf` 掉 esbuild 两棵树**（`/deno-dir/npm/registry.npmjs.org/@esbuild*`
   与 `/app/node_modules/.deno/@esbuild*`）：Trivy 门禁确实能转绿（实测退出码 0），但
   `nodeModulesDir: "auto"` 会在**容器每次启动**时按 import map 重新补装——实测重新拉取
   `drizzle-kit` / `@drizzle-team/brocli` / `esbuild@0.25.12` / `esbuild@0.28.2`（约 40 MB），
   把运行期变成对 `registry.npmjs.org` 的硬依赖（本次部署环境实测可达，但仍是可避免的
   启动延迟与脆弱点）；且按路径剪枝会随依赖布局变化**静默失效**（本次实测：
   `_modules` 路径不存在，真实副本在 `/app/node_modules/.deno`，仅凭 CI 日志猜路径会剪错）。
2. **把 `nodeModulesDir` 由 `auto` 改为 `manual`**：能阻止自动安装，但会改变整个模块的
   开发者体验（本地需显式 `deno install`），超出本次缺陷修复范围。
3. **在 Trivy 配置里忽略这些 CVE 或调低门禁**：会让"构建期工具混入运行镜像"这一真实
   缺陷继续保持不可见，属放宽安全门禁，不采纳。

## Consequences

- 网关镜像不再包含 Go 工具链产物，发布门禁可通过；镜像减小约 178 MB，容器启动不再联网补装依赖。
- 运行期依赖图与 import map 的语义变准确：dev-only 工具只以**完整 URL** 出现，不再被
  `nodeModulesDir: "auto"` 带入运行镜像。`drizzle.config.ts` 已就地留注释说明这一点，
  防止后续把 `drizzle-kit` 加回 `imports`。
- 发布链路的**第二处脆弱点**仍需单独处理：Release 资产必须在 workflow 成功后才存在，
  期间 `noj-cli install` 不可用。本次仅解除门禁阻塞，不改变该时序；若要在门禁失败时也让
  `install` 可用，需要另行设计（如允许从 tag 直接取部署文件或本地 `--files-only` 兜底）。
