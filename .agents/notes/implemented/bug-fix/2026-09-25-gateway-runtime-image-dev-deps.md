# Agent Note: 网关运行镜像混入构建期依赖，阻塞生产镜像发布

Status: implemented

## Problem

2026-09-25 发布 `v0.10.0` 时，Release Images 工作流的 `noj-llm-gateway` 矩阵任务在
Trivy 门禁（`severity: CRITICAL,HIGH` + `ignore-unfixed: true` + `exit-code: 1`）失败：

- 命中目标：`/app/node_modules/.deno/@esbuild+linux-x64@{0.18.20,0.25.12}/node_modules/@esbuild/linux-x64/bin/esbuild`
  与 `/deno-dir/npm/registry.npmjs.org/@esbuild/linux-x64/{0.18.20,0.25.12}/bin/esbuild`，
  被识别为 Go 二进制，分别报 27 与 22 项 HIGH/CRITICAL（`Total: 27 (HIGH: 25, CRITICAL: 2)` 等）。
- 影响面远大于单个镜像：`build-and-gate` 矩阵失败 →
  `verify-release` / `publish-cli` / `publish-release` 全部不执行，于是该镜像没有正式标签，
  Release **既没有 `noj-cli-linux-amd64`，也没有 `docker-compose.prod.yml` /
  `.env.prod.example`**；而 `noj-cli install` 第 1 步会**无条件**从同版本 Release 下载后两者
  并校验 SHA-256（`noj-cli/src/prod/bootstrap.ts` 的 `RELEASE_FILES`）→ **任何版本、任何 ref
  的 `install` 都在 bootstrap 步骤 404**。`v0.9.5` 的 Release 缺同样资产，是同一个原因。

### 真实机制（初版修复不充分，已实测纠正）

初版只把 `drizzle-kit` 移出 `deno.json` 的 `imports`，门禁仍然失败。实测复现 CI 结果后确认：

- `nodeModulesDir: "auto"` 安装的不是 import map 里的包，而是 **`deno.lock` 中解析出的整个
  npm 包集合**。只要 lock 里还有 dev 链（`drizzle-kit` → `esbuild`），镜像里就会出现它。
- 初版把 lock 用「含 `drizzle.config.ts`」的入口重新生成，dev 链因此留在 lock 里 →
  本地构建出的镜像同样出现 18 个 `@esbuild*` 目录、6 个 Go 二进制（与 CI 完全一致，可复现）。

## Decision

两处一起改，使**运行期依赖图与 lock 都不含 dev 链**：

1. `noj-llm-gateway/deno.json`
   - `imports` 删除 `"drizzle-kit"`（`src/` 运行期不引用；它只服务 `drizzle.config.ts`
     与 `db:generate` 任务）；
   - `db:generate` 任务加 `--no-lock`：开发者跑生成迁移时不会把 dev 链写回 lock。
2. `noj-llm-gateway/drizzle.config.ts`：改用完整 URL 说明符
   `npm:drizzle-kit@0.31.10`（版本仍精确钉住），并就地留注释禁止加回 `imports`。
3. `noj-llm-gateway/deno.lock`：以**非 dev 图**（`src/main.ts`、`src/mod.ts`、`tests/*.ts`、
   `scripts/*.ts`，排除 `drizzle.config.ts`）重新解析 → 25 262 B → **3 662 B**，dev 链
   0 处提及；`deno cache --frozen` 对该图退出码 0（lock 与图一致）。

实测（同一 Dockerfile 构建出的镜像）：Go 二进制 0 个；`/app/node_modules` 仅
`drizzle-orm` / `hono` / `ioredis` / `postgres`；Trivy 同参数复扫**退出码 0**；
`--network none` 启动**无任何 `Download` 行**；镜像 432 MB → **254 MB**。

## Alternatives considered

1. **在 Dockerfile 里 `rm -rf` 掉 esbuild 两棵树**：Trivy 门禁能转绿（实测退出码 0），但
   `nodeModulesDir: "auto"` 会在**容器每次启动**时按 lock 重新补装——实测重新拉取
   `drizzle-kit` / `@drizzle-team/brocli` / `esbuild@0.25.12` / `esbuild@0.28.2`（约 40 MB），
   把运行期变成对 `registry.npmjs.org` 的硬依赖；且按路径剪枝会随依赖布局变化静默失效
   （实测真实副本在 `/app/node_modules/.deno`，仅凭 CI 日志猜路径会剪错）。
2. **`nodeModulesDir: "auto"` 改为 `"manual"`**：实测 Docker 构建失败——
   `deno cache --lock=deno.lock src/main.ts` 在该模式下非零退出，运行镜像无法构建。
3. **构建与运行都加 `--node-modules-dir=none`**：仍会下载 lock 中的包，未解决问题。
4. **镜像内删除 `deno.lock` 后再解析**：镜像会干净且启动不再补装，但运行镜像失去 lock 的
   完整性校验与版本可复现性（import map 用的是 `npm:hono@^4` 这类范围），对发布流水线是净损失。
5. **在 Trivy 配置里忽略这些 CVE 或调低门禁**：会让"构建期工具混入运行镜像"这一真实缺陷
   继续保持不可见，属放宽安全门禁，不采纳。

## Consequences

- 网关运行镜像不再包含 Go 工具链产物，发布门禁可通过；镜像减小约 178 MB，容器启动不再联网补装依赖。
- **网关的 `deno.lock` 不再钉住 dev-only 的 `drizzle-kit` 链**（该链版本由 `drizzle.config.ts`
  与 `db:generate` 里的完整 URL 说明符精确钉住，且 `--no-lock` 保证不回写）。这是有意的取舍：
  运行镜像的可复现性与完整性校验优先，dev 工具的锁定改由显式版本号承担。
- 后续若再把 dev-only 工具登记进网关 `imports`，或把 `drizzle.config.ts` 纳入 lock 解析入口，
  该链会立即重新进入运行镜像并再次触发门禁——`drizzle.config.ts` 的就地注释与
  `db:generate` 的 `--no-lock` 是防回归的两道闸门。
- 发布链路的**第二处脆弱点**未变：Release 资产只在 workflow 成功后才存在，期间
  `noj-cli install` 不可用。本次仅解除门禁阻塞，不改变该时序。
