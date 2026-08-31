# noj-cli P5：noj-server 二进制构建 + 镜像改名 + 文档迁移 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 noj-core 新增 `noj-server`（linux/amd64）的 `deno compile` 构建脚本；将 `docker-compose.prod.yml` 中 noj-core 镜像/服务改名为 noj-server 并同步内部引用；将 `setup.sh` 改造为仅下载/校验 noj-cli 的薄引导；迁移 README、deploy/README、noj-docs 生产部署文档；并新增构建冒烟测试与文档链接检查。

**Architecture:** `noj-server` 由 `noj-core` 源码通过 `deno compile --target x86_64-unknown-linux-gnu` 产出单文件二进制 `noj-core/bin/noj-server`，构建入口为 `noj-core/scripts/build-server.sh` + `deno task build:server`。`docker-compose.prod.yml` 中服务 `core` 与镜像 `ghcr.io/neuro-oj/noj-core` 全局改名为 `server` / `ghcr.io/neuro-oj/noj-server`，同步 `NUXT_API_BASE`、`depends_on`、锚点名与注释。`setup.sh` 不再下载 bootstrap 脚本，改为从 GitHub Releases 下载 `noj-cli-linux-amd64`、SHA-256 校验后 exec `noj-cli`。文档迁移聚焦“镜像/服务/二进制名”层面（模块源码目录 `noj-core/` 与代码级标识按 glossary 规则保留原名）。新增仓库级校验脚本 `scripts/deploy/verify-*.ts`（含 Deno 测试）接入 `scripts/check-all.ts` / `scripts/check-ci.ts`，`scripts/verify-md-links.ts` 作为文档链接门禁。

**Tech Stack:** Deno 2（TypeScript）、`deno compile`（linux/amd64，`--target x86_64-unknown-linux-gnu`）、Docker Compose、bash（setup.sh 与构建脚本）、Jujutsu (jj) 本地提交。仅支持 `linux/amd64`。

**Spec:** `docs/superpowers/specs/2026-08-31-noj-cli-design.md`（P5 子集：noj-server 构建 + 镜像改名 + setup.sh 薄引导 + 文档迁移 + 冒烟测试）

## Global Constraints

- 语言：代码与文档中的注释/提交描述用中文；代码标识符与配置键用英文。
- 平台：**仅支持 `linux/amd64`**（对应 `x86_64`）；构建脚本 `uname -m` 非 `x86_64`/`amd64` 时直接报错退出；`setup.sh` 同样拒绝非 amd64。
- 镜像/服务改名范围：`ghcr.io/neuro-oj/noj-core` → `ghcr.io/neuro-oj/noj-server`；Compose 服务 `core` → `server`；API 服务二进制产物名 `noj-core` → `noj-server`。
- 命名保留规则：模块源码目录 `noj-core/`、代码级标识（如 `noj-core` 出现在“与 noj-core 白名单一致”、`cd noj-core` 等源码路径/代码语义处）按设计文档 glossary 规则**保留原名**；本次只改“镜像名 / Compose 服务名 / 服务二进制产物名”。
- 范围外（本 P5 不改，留后续阶段）：`.github/workflows/release.yml` 的矩阵镜像 `noj-core` 与 `/app/bin/noj-core` 校验、`scripts/staging/acceptance.sh`、`scripts/release/check-supply-chain.sh`（它们当前仍构建/发布 `noj-core` 镜像；P5 只让 compose 指向新名，CI/Release 对齐属后续计划）。
- 环境变量合并规则、状态机等 P0–P4 公共接口不变，本计划不改动 `src/config/*`、`src/state/*`、`src/util/*` 的签名。
- 测试：Deno 测试通过 `deno test -A` 运行；仓库级门禁经 `scripts/check-all.ts` 运行（含 `scripts/verify-md-links.ts`）；构建冒烟测试经 `scripts/deploy/test-build-server.sh`（开启 `NOJ_BUILD_SMOKE=1` 时才真正执行 `deno compile`）。
- 提交使用 jj：`jj split <files>` + `jj describe -m "<type>(<scope>): <中文描述>"`，scope 用 `cli`（构建/Compose 迁移用 `build`/`root` 亦可），GPG 签名仓库已全局开启。
- 构建产物 `noj-core/bin/noj-server` 不得提交，须在 `.gitignore` 加入 `noj-core/bin/`。
- 不修改与 P5 无关的既有业务代码（不触碰 `noj-core/src/*` 业务逻辑、`AGENTS.md` 等）。

---

### Task 1: noj-server 构建脚本 `noj-core/scripts/build-server.sh`

**Files:**
- Create: `noj-core/scripts/build-server.sh`
- Create: `scripts/deploy/verify-build-server.ts`
- Create: `scripts/deploy/verify-build-server_test.ts`
- Create: `scripts/deploy/test-build-server.sh`（真实构建冒烟，`NOJ_BUILD_SMOKE=1` 开启）
- Modify: `noj-core/deno.json`（新增 `build:server` / `build:server:smoke` 任务）
- Modify: `.gitignore`（新增 `noj-core/bin/`）

**Interfaces:**
- Consumes: `noj-core/src/main.ts`（API 服务入口，Task 1 不修改）；`noj-core/deno.json` 现有内容。
- Produces:
  - `noj-core/scripts/build-server.sh`：无参 bash 脚本；输出 `noj-core/bin/noj-server`（linux/amd64）。
  - `noj-core/deno.json` 新增任务：`build:server`（`bash scripts/build-server.sh`）、`build:server:smoke`（`bash scripts/build-server.sh && ./bin/noj-server --version`）。
  - `scripts/deploy/verify-build-server.ts`：`export function verifyBuildServerScript(): string[]`（返回问题清单，空数组为通过；`--check` 模式打印并退出非零）；供后续任务与 `check-all.ts` 复用。
  - `scripts/deploy/test-build-server.sh`：真实编译冒烟，仅 `NOJ_BUILD_SMOKE=1` 时执行。

- [ ] **Step 1: 写失败测试 `scripts/deploy/verify-build-server.ts` + `_test.ts`**

创建 `scripts/deploy/verify-build-server.ts`：

```ts
/** 校验 noj-server 构建脚本与 deno task 配置（P5 构建冒烟门禁）。 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function readLines(rel: string): string[] {
  const p = path.join(ROOT, rel);
  return Deno.readTextFileSync(p).split(/\r?\n/);
}

/** 返回问题清单；空数组表示通过。 */
export function verifyBuildServerScript(): string[] {
  const problems: string[] = [];
  const lines = readLines("noj-core/scripts/build-server.sh");
  const joined = lines.join("\n");

  if (!joined.includes("deno compile")) {
    problems.push("build-server.sh 未使用 deno compile");
  }
  if (!joined.includes("--target x86_64-unknown-linux-gnu")) {
    problems.push("build-server.sh 未指定 linux/amd64 目标");
  }
  if (!joined.includes("bin/noj-server")) {
    problems.push("build-server.sh 未输出 bin/noj-server");
  }
  if (!joined.includes("src/main.ts")) {
    problems.push("build-server.sh 未引用 src/main.ts 入口");
  }

  const denoJson = JSON.parse(Deno.readTextFileSync(
    path.join(ROOT, "noj-core/deno.json"),
  )) as { tasks?: Record<string, string> };
  const buildTask = denoJson.tasks?.["build:server"] ?? "";
  if (!buildTask.includes("scripts/build-server.sh")) {
    problems.push("deno.json 缺 build:server 任务（指向 scripts/build-server.sh）");
  }

  const scriptExists = lines.length > 1 && lines[0]?.startsWith("#!/usr/bin/env bash");
  if (!scriptExists) {
    problems.push("build-server.sh 缺少 shebang（#!/usr/bin/env bash）");
  }
  return problems;
}

if (import.meta.main) {
  const problems = verifyBuildServerScript();
  if (problems.length > 0) {
    console.error("❌ noj-server 构建门禁失败：\n- " + problems.join("\n- "));
    Deno.exit(1);
  }
  console.log("✅ noj-server 构建脚本门禁通过");
}
```

创建 `scripts/deploy/verify-build-server_test.ts`（沿用仓库根测试约定：无根 `deno.json`，用本地 `assert` 辅助函数，不用 `@std/assert`）：

```ts
import { verifyBuildServerScript } from "./verify-build-server.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("build-server 门禁：脚本与 task 缺一不可", () => {
  const problems = verifyBuildServerScript();
  assert(problems.length === 0, `应无问题，实际: ${problems.join("; ")}`);
});
```

> 说明：仓库根没有 `deno.json` / imports 映射，既有根测试（如 `scripts/verify-md-links_test.ts`）都用本地 `assert(cond, msg)` 辅助函数而非 `@std/assert`；`scripts/deploy/verify-build-server.ts` 只依赖 `node:path`（与 `scripts/verify-md-links.ts` 一致），不引入任何裸包依赖。

- [ ] **Step 2: 运行测试确认失败**

Run: `deno test -A --no-check scripts/deploy/verify-build-server_test.ts`
Expected: FAIL——`verifyBuildServerScript()` 返回非空（`build-server.sh` 尚不存在，`Deno.readTextFileSync` 抛 `ENOENT`）。

- [ ] **Step 3: 实现 `noj-core/scripts/build-server.sh`**

创建 `noj-core/scripts/build-server.sh`：

```bash
#!/usr/bin/env bash
#
# 编译 noj-server：由 noj-core 源码经 deno compile 产出 linux/amd64 单文件二进制。
# 产物：<repo>/noj-core/bin/noj-server
#
# 仅支持 linux/amd64。

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# 仅支持 linux/amd64（对应 x86_64）
case "$(uname -m)" in
  x86_64 | amd64) ;;
  *) printf '仅支持 linux/amd64；当前架构 %s 不支持。\n' "$(uname -m)" >&2; exit 1 ;;
esac

mkdir -p bin

deno compile \
  -A --no-check --unstable-byonm --unstable-node-globals \
  --target x86_64-unknown-linux-gnu \
  --output bin/noj-server \
  src/main.ts
```

修改 `noj-core/deno.json` 的 `"tasks"` 对象，插入（放在 `"dev"` 之前或之后均可，保持 JSON 合法）：

```json
    "build:server": "bash scripts/build-server.sh",
    "build:server:smoke": "bash scripts/build-server.sh && ./bin/noj-server --version",
```

修改 `.gitignore`，在 `# --- Problem Data (noj-core) ---` 段之前追加一节：

```gitignore
# --- noj-server 构建产物 ---
noj-core/bin/
```

- [ ] **Step 4: 运行测试确认通过**

Run: `deno test -A --no-check scripts/deploy/verify-build-server_test.ts`
Expected: PASS（脚本内容、`--target x86_64-unknown-linux-gnu`、`bin/noj-server`、`src/main.ts`、`build:server` task、shebang 全部命中）。

- [ ] **Step 5: 创建真实构建冒烟脚本 `scripts/deploy/test-build-server.sh`**

创建 `scripts/deploy/test-build-server.sh`：

```bash
#!/usr/bin/env bash
#
# 真实构建冒烟测试（默认跳过；NOJ_BUILD_SMOKE=1 时执行真实 deno compile）。
# 需要 linux/amd64 主机（CI ubuntu-latest 满足）。
set -Eeuo pipefail

if [[ "${NOJ_BUILD_SMOKE:-0}" != "1" ]]; then
  echo "跳过真实编译（设置 NOJ_BUILD_SMOKE=1 启用）"
  exit 0
fi

# 本脚本位于 <repo>/scripts/deploy/，向上两级即仓库根。
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUILD="$ROOT_DIR/scripts/../noj-core/scripts/build-server.sh"
BIN="$ROOT_DIR/noj-core/bin/noj-server"

"$BUILD"
test -x "$BIN"
"$BIN" --version >/dev/null 2>&1
echo "✅ noj-server 真实构建冒烟通过：$BIN"
```

> 说明：`ROOT_DIR` 为仓库根；`BUILD` 通过 `$ROOT_DIR/scripts/../noj-core/scripts/build-server.sh` 等价指向仓库根下 `noj-core/scripts/build-server.sh`；`BIN` 指向 `noj-core/bin/noj-server`。创建后执行 `chmod +x scripts/deploy/test-build-server.sh`。

- [ ] **Step 6: 验证冒烟脚本 shell 语法（不真正编译）**

Run: `bash -n scripts/deploy/test-build-server.sh && NOJ_BUILD_SMOKE=0 bash scripts/deploy/test-build-server.sh`
Expected: `bash -n` 无输出（语法 OK）；随后输出“跳过真实编译”。

- [ ] **Step 7: 运行格式与全量测试并提交**

Run: `deno fmt --check scripts/deploy/verify-build-server*.ts && deno lint && deno test -A --no-check scripts/deploy/verify-build-server_test.ts`
Expected: 全部通过。

```bash
jj split noj-core/scripts/build-server.sh noj-core/deno.json .gitignore \
  scripts/deploy/verify-build-server.ts scripts/deploy/verify-build-server_test.ts \
  scripts/deploy/test-build-server.sh
jj describe -m "build(cli): 新增 noj-server 构建脚本与冒烟门禁"
```

> 说明：`build:server:smoke` 任务已写入 deno.json；若希望本任务的独立可验证点包含真实编译，可手动执行 `cd noj-core && NOJ_BUILD_SMOKE=1 bash ../scripts/deploy/test-build-server.sh`（可选、较慢）。

---

### Task 2: docker-compose.prod.yml noj-core → noj-server（镜像/服务/内部引用）

**Files:**
- Modify: `docker-compose.prod.yml`
- Create: `scripts/deploy/verify-compose-server.ts`
- Create: `scripts/deploy/verify-compose-server_test.ts`

**Interfaces:**
- Consumes: 仓库根 `docker-compose.prod.yml` 现有内容。
- Produces:
  - `scripts/deploy/verify-compose-server.ts`：`export function verifyComposeServer(): string[]`（返回问题清单；`--check` 模式打印并退出非零）。
  - compose 改名后的稳定契约，Task 3/4/5 的文档与校验都依赖：服务名 `server`、镜像 `ghcr.io/neuro-oj/noj-server`、锚点 `x-server-env`、`NUXT_API_BASE: http://server:8000`、`ui.depends_on` 含 `server`。

- [ ] **Step 1: 写失败测试 `scripts/deploy/verify-compose-server.ts` + `_test.ts`**

创建 `scripts/deploy/verify-compose-server.ts`：

```ts
/** 校验 docker-compose.prod.yml 已从 noj-core/core 改名为 noj-server/server。 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const COMPOSE = path.join(ROOT, "docker-compose.prod.yml");

/** 返回问题清单；空数组表示通过。 */
export function verifyComposeServer(): string[] {
  const problems: string[] = [];
  const text = Deno.readTextFileSync(COMPOSE);

  if (text.includes("noj-core")) {
    problems.push("compose 仍出现 noj-core（应全部改名 noj-server）");
  }
  if (/^\s{2}core:\s*$/m.test(text)) {
    problems.push("compose 仍存在服务 core（应为 server）");
  }
  if (!text.includes("x-server-env: &server-env")) {
    problems.push("compose 缺少锚点 x-server-env: &server-env（应替换 x-core-env）");
  }
  if (!text.includes("/noj-server:${NOJ_VERSION")) {
    problems.push("compose server/migrate 镜像未使用 ghcr.io/neuro-oj/noj-server");
  }
  if (!/^\s{2}server:\s*$/m.test(text)) {
    problems.push("compose 缺少服务 server");
  }
  if (!text.includes("NUXT_API_BASE: http://server:8000")) {
    problems.push("ui 的 NUXT_API_BASE 未指向 http://server:8000");
  }
  // ui 的 depends_on 下必须有 server；该行缩进 6 空格，形如 `      server:`
  if (!/^\s{6}server:\s*$/m.test(text)) {
    problems.push("depends_on 中缺少 server 依赖项");
  }
  return problems;
}

if (import.meta.main) {
  const problems = verifyComposeServer();
  if (problems.length > 0) {
    console.error("❌ Compose 改名门禁失败：\n- " + problems.join("\n- "));
    Deno.exit(1);
  }
  console.log("✅ docker-compose.prod.yml 改名门禁通过");
}
```

创建 `scripts/deploy/verify-compose-server_test.ts`（沿用仓库根本地 `assert` 约定）：

```ts
import { verifyComposeServer } from "./verify-compose-server.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("Compose 改名门禁：无 noj-core && 有 server", () => {
  const problems = verifyComposeServer();
  assert(problems.length === 0, `应无问题，实际: ${problems.join("; ")}`);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `deno test -A --no-check scripts/deploy/verify-compose-server_test.ts`
Expected: FAIL——当前 compose 含 `noj-core` 与服务 `core`，返回非空。

- [ ] **Step 3: 实现 docker-compose.prod.yml 改名**

对 `docker-compose.prod.yml` 做以下**精确替换**（用 `str_replace` 逐处执行，避免误伤）：

1. 顶部注释 `core/judge/db/redis/minio 不暴露到宿主机` → `server/judge/db/redis/minio 不暴露到宿主机`（第 8 行附近）。
2. `x-core-env: &core-env` → `x-server-env: &server-env`（锚点定义，共 1 处；下面两处 `<<: *core-env` 同步改）。
3. `migrate:` 服务内的 `image: "${NOJ_IMAGE_REGISTRY:-ghcr.io/neuro-oj}/noj-core:${NOJ_VERSION:?NOJ_VERSION is required}"` → 把 `noj-core` 改为 `noj-server`；其下 `<<: *core-env` → `<<: *server-env`。
4. `  # ── 核心 API ──` 注释 → `  # ── 服务端 API（noj-server） ──`。
5. `  core:` 服务定义 → `  server:`；其 `image:` 中 `noj-core` → `noj-server`；`<<: *core-env` → `<<: *server-env`。
6. `ui:` 服务内 `NUXT_API_BASE: http://core:8000` → `NUXT_API_BASE: http://server:8000`；`    depends_on:\n      core:` → `    depends_on:\n      server:`。

替换完成后，用只读确认没有残留：`grep -n "noj-core\|core-env\|http://core\|^  core:" docker-compose.prod.yml` 应无输出（除第 6 步已改的）；`grep -n "server" docker-compose.prod.yml` 应出现服务 `server:`、镜像 `noj-server`、`http://server:8000`、`x-server-env`。

> 关键：`migrate` 服务内 `command` 中的 `/app/bin/noj` 是镜像内管理 CLI 二进制路径，**不属于**镜像/服务改名范围，保持原样。

- [ ] **Step 4: 运行测试确认通过**

Run: `deno test -A --no-check scripts/deploy/verify-compose-server_test.ts`
Expected: PASS。

- [ ] **Step 5: 语法与解析校验**

Run: `docker compose -f docker-compose.prod.yml --env-file .env.prod.example config >/dev/null 2>&1 && echo OK || echo "（需真实 .env 或环境变量，仅确认语法结构）"`
Expected: 若因 `.env.prod.example` 中 `NOJ_VERSION=change-me-release-tag` 缺凭据导致报错可接受；关键是没有 YAML/结构语法错误（`docker compose config` 若因必填变量失败，改用 `docker compose -f docker-compose.prod.yml config --quiet` 并确认报错只是“变量未设置”类，而非解析错误）。

- [ ] **Step 6: 运行格式与 lint 并提交**

Run: `deno fmt --check scripts/deploy/verify-compose-server*.ts && deno lint scripts/deploy/verify-compose-server*.ts`
Expected: 通过。

```bash
jj split docker-compose.prod.yml \
  scripts/deploy/verify-compose-server.ts scripts/deploy/verify-compose-server_test.ts
jj describe -m "refactor(root): docker-compose.prod.yml 核心服务改名 noj-server/server"
```

---

### Task 3: setup.sh 改为仅下载/校验 noj-cli 的薄引导

**Files:**
- Modify: `setup.sh`
- Create: `scripts/deploy/verify-setup-thin.ts`
- Create: `scripts/deploy/verify-setup-thin_test.ts`

**Interfaces:**
- Consumes: 仓库根 `setup.sh` 现有内容；GitHub Releases 资产命名约定 `noj-cli-linux-amd64`（P0–P4 定义 noj-cli 发布名）。
- Produces:
  - `scripts/deploy/verify-setup-thin.ts`：`export function verifySetupThin(): string[]`（返回问题清单；`--check` 模式打印并退出非零）。
  - 新的 `setup.sh` 薄引导契约：仅支持 linux/amd64；下载 `noj-cli-linux-amd64` 与其 `.sha256`；SHA-256 校验（可用 `NOJ_CLI_SHA256` 覆盖）；安装到 `NOJ_INSTALL_DIR`（默认 `/opt/neuro-oj`）并 exec `noj-cli`；**不再下载任何 bootstrap/install.sh**。

- [ ] **Step 1: 写失败测试 `scripts/deploy/verify-setup-thin.ts` + `_test.ts`**

创建 `scripts/deploy/verify-setup-thin.ts`：

```ts
/** 校验 setup.sh 为“仅下载/校验 noj-cli”的薄引导，不再拉取 bootstrap。 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** 返回问题清单；空数组表示通过。 */
export function verifySetupThin(): string[] {
  const problems: string[] = [];
  const text = Deno.readTextFileSync(path.join(ROOT, "setup.sh"));

  if (!text.includes("noj-cli-linux-amd64")) {
    problems.push("setup.sh 未下载 noj-cli-linux-amd64");
  }
  if (!text.includes(".sha256") || !text.includes("sha256sum")) {
    problems.push("setup.sh 缺少 SHA-256 下载/校验");
  }
  if (!text.includes("NOJ_CLI_SHA256")) {
    problems.push("setup.sh 缺少可覆盖的 NOJ_CLI_SHA256 校验变量");
  }
  if (!text.includes("exec ") || !text.includes("noj-cli")) {
    problems.push("setup.sh 未在末尾 exec noj-cli");
  }
  if (/bootstrap|scripts\/deploy\/install\.sh/.test(text)) {
    problems.push("setup.sh 仍引用旧 bootstrap/install.sh（应删除）");
  }
  return problems;
}

if (import.meta.main) {
  const problems = verifySetupThin();
  if (problems.length > 0) {
    console.error("❌ setup.sh 薄引导门禁失败：\n- " + problems.join("\n- "));
    Deno.exit(1);
  }
  console.log("✅ setup.sh 薄引导门禁通过");
}
```

创建 `scripts/deploy/verify-setup-thin_test.ts`（沿用仓库根本地 `assert` 约定）：

```ts
import { verifySetupThin } from "./verify-setup-thin.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("setup.sh 薄引导门禁：仅下载/校验 noj-cli", () => {
  const problems = verifySetupThin();
  assert(problems.length === 0, `应无问题，实际: ${problems.join("; ")}`);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `deno test -A --no-check scripts/deploy/verify-setup-thin_test.ts`
Expected: FAIL——当前 setup.sh 下载 `scripts/deploy/install.sh`（bootstrap），无 `noj-cli-linux-amd64` / SHA-256 校验。

- [ ] **Step 3: 用薄引导版本整体替换 `setup.sh`**

`setup.sh` 全文改为（用 `write` 整体覆盖）：

```bash
#!/usr/bin/env bash
#
# Neuro OJ 唯一公开的一键安装入口（薄引导）。
#
# 只负责：下载并 SHA-256 校验 noj-cli 二进制，然后交给 noj-cli 完成
# doctor / deploy init / deploy up 等全部部署与运维。
#
# 推荐用法：
#   curl -fsSL https://raw.githubusercontent.com/Neuro-OJ/neuro-oj/main/setup.sh | bash
#
# 环境变量：
#   NOJ_CLI_VERSION   noj-cli 版本（默认 latest，可固定如 0.1.0）
#   NOJ_CLI_SHA256    期望的 noj-cli SHA-256（推荐固定，作防篡改锚点）
#   NOJ_INSTALL_DIR   安装目录（默认 /opt/neuro-oj）

set -Eeuo pipefail

readonly BASE_URL="${NOJ_CLI_DOWNLOAD_BASE:-https://github.com/Neuro-OJ/neuro-oj/releases/download}"
readonly VERSION="${NOJ_CLI_VERSION:-latest}"
readonly INSTALL_DIR="${NOJ_INSTALL_DIR:-/opt/neuro-oj}"
readonly BIN_DIR="$INSTALL_DIR/bin"
readonly BIN="$BIN_DIR/noj-cli"
readonly EXPECTED_SHA="${NOJ_CLI_SHA256:-}"

# 仅支持 linux/amd64
case "$(uname -m)" in
  x86_64 | amd64) ;;
  *) printf '仅支持 linux/amd64；当前架构 %s 不支持。\n' "$(uname -m)" >&2; exit 1 ;;
esac

if [[ -z "$(command -v curl)" && -z "$(command -v wget)" ]]; then
  printf '需要 curl 或 wget，请先安装其一。\n' >&2
  exit 1
fi

resolve_tag() {
  if [[ "$VERSION" != "latest" ]]; then
    printf '%s' "$VERSION"
    return
  fi
  curl -fsSL "https://api.github.com/repos/Neuro-OJ/neuro-oj/releases/latest" \
    | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n1
}

fetch() { # <url> <out>
  if command -v curl >/dev/null 2>&1; then
    curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
      --retry 3 --connect-timeout 15 --output "$2" "$1"
  else
    wget --https-only --tries=3 --timeout=20 --quiet --output-document="$2" "$1"
  fi
}

tag="$(resolve_tag)"
[[ -n "$tag" ]] || { printf '无法解析 noj-cli 版本。\n' >&2; exit 1; }

mkdir -p "$BIN_DIR"
tmp="$(mktemp "${TMPDIR:-/tmp}/noj-cli.XXXXXX")"
trap 'rm -f -- "$tmp" "$tmp.sha256"' EXIT

version_without_v="${tag#v}"
asset="noj-cli-linux-amd64"
url="$BASE_URL/$version_without_v/$asset"

fetch "$url" "$tmp"
fetch "$url.sha256" "$tmp.sha256"

actual="$(sha256sum "$tmp" | awk '{print $1}')"
expected="$(awk '{print $1}' "$tmp.sha256")"
if [[ -n "$EXPECTED_SHA" ]]; then
  expected="$EXPECTED_SHA"
fi
[[ "$actual" == "$expected" ]] || {
  printf 'noj-cli SHA-256 校验失败：期望 %s，实际 %s\n' "$expected" "$actual" >&2
  exit 1
}

install -m 0755 "$tmp" "$BIN"
ln -sf "$BIN" "$INSTALL_DIR/noj"
exec "$BIN" "$@"
```

- [ ] **Step 4: 运行测试确认通过**

Run: `deno test -A --no-check scripts/deploy/verify-setup-thin_test.ts`
Expected: PASS。

- [ ] **Step 5: shell 语法校验**

Run: `bash -n setup.sh`
Expected: 无输出（语法 OK）。

- [ ] **Step 6: 运行格式与 lint 并提交**

Run: `deno fmt --check scripts/deploy/verify-setup-thin*.ts && deno lint scripts/deploy/verify-setup-thin*.ts`
Expected: 通过。

```bash
jj split setup.sh scripts/deploy/verify-setup-thin.ts scripts/deploy/verify-setup-thin_test.ts
jj describe -m "refactor(root): setup.sh 改为仅下载/校验 noj-cli 的薄引导"
```

---

### Task 4: README 与 deploy/README 迁移

**Files:**
- Modify: `README.md`
- Modify: `deploy/README.md`
- Test: 依赖既有 `scripts/verify-md-links.ts`（文档链接门禁）

**Interfaces:**
- Consumes: Task 2 的 compose 契约（服务 `server`、镜像 `noj-server`）；Task 3 的 setup.sh 薄引导契约。
- Produces: 仓库根与 deploy/ 下面向用户的生产部署说明，与 `setup.sh` 薄引导 + `noj-server` 镜像/服务命名一致。

- [ ] **Step 1: 更新 `README.md` 一键部署与运维命令**

对 `README.md` 做以下精确替换：

1. 第 78 行附近镜像清单：`获取 `noj-core`、`noj-ui`、`noj-judge` 等镜像` → `获取 `noj-server`、`noj-ui`、`noj-judge` 等镜像`。
2. “一键部署”段落（约 120–133 行）——把“临时下载底层安装脚本，下载指定 Release 到目标目录，并调用生产部署向导”改为“下载并 SHA-256 校验 `noj-cli` 二进制，然后交给 `noj-cli` 完成环境检测与生产部署”：

将 README 原“一键部署”段落的正文替换为下面这段（其中含一个 bash 代码块，用 4 个反引号包裹最外层、内层用 3 个反引号，避免渲染冲突）：

````markdown
### 一键部署

生产环境推荐使用仓库根目录的一键安装入口 `setup.sh`。它是仅下载并校验 `noj-cli`
二进制的薄引导：先检查当前主机（Linux / amd64 / 基础工具），从 GitHub Releases
下载 `noj-cli-linux-amd64` 并做 SHA-256 校验，然后交由 `noj-cli` 完成环境
检测（doctor）与生产部署（deploy init / deploy up）：

```bash
curl -fsSL https://raw.githubusercontent.com/Neuro-OJ/neuro-oj/main/setup.sh | bash
```

如需先检查脚本，可先下载 `setup.sh` 再执行。安装完成后，服务启停、更新和管理统一
使用安装目录中的 `noj-cli` 命令。
````

3. 运维命令清单（约 146–147 行）：`./noj status` / `./noj logs core` → 改为 `noj-cli doctor` / `noj-cli maintain logs server`；并同步把该清单里的 `./noj ...` 命令替换为 `noj-cli ...`（`status`→`deploy status`、`update`→（无升级，改为 `maintain verify` 或保留说明）、`stop`→`deploy down`、`restart`→`deploy restart`、`uninstall`→（无卸载，改 `maintain reset --include-deploy-configs` 需确认）、`backup`→`maintain backup create`、`config check`→`maintain config check`）。为降低误改风险，**只替换明确出现旧命令的代码块**：

```bash
noj-cli doctor                      # 环境检测
noj-cli deploy status               # 查看服务状态
noj-cli maintain logs server        # 查看 server 日志
noj-cli deploy restart              # 重启服务
noj-cli deploy down                 # 停止服务但保留数据卷
noj-cli deploy up                   # 再次启动
noj-cli maintain backup create      # 创建生产备份
noj-cli maintain config check       # 只校验配置，不改变服务状态
```

4. 故障排查（约 222 行）`执行 bash scripts/deploy/deploy.sh status 和 ... logs <service>` → `执行 noj-cli doctor 和 noj-cli deploy status、noj-cli maintain logs <service>`（旧脚本已废弃）。

- [ ] **Step 2: 更新 `deploy/README.md`**

对 `deploy/README.md` 做以下替换：

1. “首次安装与生产运维”段（约 20–40 行）：把 `推荐使用仓库根目录的 `noj` 入口` 改为 `推荐使用仓库根目录的一键安装入口 `setup.sh`（仅下载/校验 `noj-cli`）与 `noj-cli` 命令`；把示例命令中的 `setup.sh | bash -s -- --dir /opt/neuro-oj` 改为 `setup.sh | bash`（薄引导不再传 `--dir`，安装目录由 `NOJ_INSTALL_DIR` 控制）；把运维清单 `./noj logs core` → `noj-cli maintain logs server`，其余 `./noj start/restart/backup/config check` 对应改为 `noj-cli deploy up` / `noj-cli deploy restart` / `noj-cli maintain backup create` / `noj-cli maintain config check`。
2. 删除/改写其中关于“`update` / `upgrade`”与“uninstall”的整段（设计非目标：无升级流程、不兼容旧命令），改为一句话：`noj-cli` 不提供升级/卸载子命令；配置变更与数据管理见 `noj-cli maintain config` 与 `noj-cli maintain reset`。
3. 保留 TLS / 反向代理正文（与镜像改名无关）。

- [ ] **Step 3: 运行文档链接门禁**

Run: `deno run -A scripts/verify-md-links.ts`
Expected: PASS（README / deploy/README 的相对链接与锚点均存在；`.vitepress/dist` 已被该脚本 EXCLUDE_DIRS 排除）。

- [ ] **Step 4: 检查无残留旧命令（只读）**

Run: `grep -n "logs core\|bash scripts/deploy/deploy.sh\|bash -s -- --dir" README.md deploy/README.md`
Expected: 无输出（或仅在明确“废弃兼容”语境出现，若出现请一并改写）。

- [ ] **Step 5: 提交**

```bash
jj split README.md deploy/README.md
jj describe -m "docs(root): 迁移 README 与 deploy/README 到 noj-cli 薄引导与 noj-server 命名"
```

---

### Task 5: noj-docs 生产部署文档迁移

**Files:**
- Modify: `noj-docs/docs/operators/production-deploy.md`
- Modify: `noj-docs/docs/operators/production-secrets.md`
- Modify: `noj-docs/docs/operators/cli.md`
- Test: 依赖 `scripts/verify-md-links.ts` + 只读 grep 断言

**Interfaces:**
- Consumes: Task 2 compose 契约（服务 `server`、镜像 `noj-server`）。
- Produces: noj-docs 运营者文档中，凡指代“生产镜像 / Compose 服务 / 服务二进制产物”处统一为 `noj-server` / `server`；源码目录 `noj-core/` 与代码级标识（如“与 noj-core 白名单一致”）保留原名。

- [ ] **Step 1: 更新 `noj-docs/docs/operators/cli.md`**

精确替换：

1. 第 3 行 `` `noj-core` 镜像内包含编译后的管理 CLI（`/app/bin/noj`） `` → `` `noj-server` 镜像内包含编译后的管理 CLI（`/app/bin/noj`） ``。
2. 第 7 行 `` 而是通过 Docker Compose 在 `noj-core` 镜像内执行 CLI `` → `` 而是通过 Docker Compose 在 `noj-server` 镜像内执行 CLI ``。

其余 `docker compose ... --entrypoint /app/bin/noj` 命令块不改（`/app/bin/noj` 是镜像内 CLI 路径，属于产品二进制命名，非本次改名范围）。

- [ ] **Step 2: 更新 `noj-docs/docs/operators/production-secrets.md`**

精确替换（均为 Compose 服务名 `core` → `server`）：

1. “S3/MinIO 应用凭据轮换”第 4 步：``重启 `core` 和 `judge``` → ``重启 `server` 和 `judge```。
2. “邮件凭据轮换”第 3 步：``重启 `core``` → ``重启 `server```。
3. “JWT 与 TFA 密钥”轮换第 3 步：``重启 `core``` → ``重启 `server```。

- [ ] **Step 3: 更新 `noj-docs/docs/operators/production-deploy.md`**

精确替换（只改镜像/服务/二进制命名，不改源码目录 `cd noj-core` 与代码级“与 noj-core 保持一致”）：

1. 第 34 行“仅用于部署前运行 `noj-core` 的配置检查命令” → `仅用于部署前运行 `noj-server` 的配置检查命令`（此处指服务配置检查语义）。
2. 第 286 行“脚本会构建并启动 `noj-core`、`noj-ui`、`noj-judge`、`noj-llm-gateway`” → `构建并启动 `noj-server`、`noj-ui`、`noj-judge`、`noj-llm-gateway`（staging acceptance 语境，指服务镜像名）`。
3. 第 64–65 行“`scripts/deploy/install.sh` 是 setup.sh 的内部 bootstrap 和旧版本兼容入口，不再作为新安装推荐命令” → 改写为“`setup.sh` 已不再下载 bootstrap 脚本；它只下载并校验 `noj-cli` 二进制，部署由 `noj-cli` 完成。`scripts/deploy/*.sh` 与 `noj` 旧命令已废弃，不兼容。”。
4. 第 48–55 行“推荐：一条命令开始安装”块内，把 `setup.sh | bash` 的说明改为薄引导：`setup.sh` 下载并校验 `noj-cli`，随后 `noj-cli doctor` / `noj-cli deploy init` 完成环境检测与部署；`--ref` / `--panel` 参数不再传递，改为 `NOJ_CLI_VERSION` 环境变量。
5. 运维命令清单（约 311–317 行、342–343 行）把 ``./noj status`` / ``./noj logs core`` 对应替换为 ``noj-cli deploy status`` / ``noj-cli maintain logs server``，并把该段其余 `./noj ...` 替换为 `noj-cli ...`（`backup`→`maintain backup create`、`config check`→`maintain config check`、`restart`→`deploy restart`、去掉 `update`/`uninstall` 行并在段末注明“noj-cli 不提供升级/卸载，见 `deploy down` / `maintain reset`”）。

> 说明：`production-deploy.md` 其余大段（宝塔面板、staging 验收、LLM 网关部署等）与本次改名的镜像/服务无关部分保持不动；仅按上述清单处理命名迁移。

- [ ] **Step 4: 运行文档链接门禁与只读断言**

Run: `deno run -A scripts/verify-md-links.ts`
Expected: PASS。

Run: `grep -rn "noj-core" noj-docs/docs/operators/*.md | grep -v "cd noj-core\|与 noj-core\|noj-core 的\|noj-core/scripts\|noj-core/data\|noj-core 侧\|noj-core 已启动"`
Expected: 无输出（即残余 `noj-core` 均属“源码目录/代码级标识保留原名”白名单内）。

- [ ] **Step 5: 提交**

```bash
jj split noj-docs/docs/operators/cli.md \
  noj-docs/docs/operators/production-secrets.md \
  noj-docs/docs/operators/production-deploy.md
jj describe -m "docs(noj-docs): 生产部署文档迁移到 noj-server/server 命名"
```

---

### Task 6: 收尾 —— 构建冒烟接入全量门禁 + 全量验证

**Files:**
- Modify: `scripts/check-all.ts`
- Modify: `scripts/check-ci.ts`
- Modify: `noj-cli/README.md`（若存在则补充 P5 说明；不存在则跳过，仅当 prior 计划已创建）
- Test: 全量门禁 `deno run -A scripts/check-all.ts` + 可选的 `NOJ_BUILD_SMOKE=1 bash scripts/deploy/test-build-server.sh`

**Interfaces:**
- Consumes: Task 1–5 产物：`verifyBuildServerScript`、`verifyComposeServer`、`verifySetupThin`（均返回 `string[]`）、`scripts/deploy/test-build-server.sh`、`scripts/verify-md-links.ts`。
- Produces: `scripts/check-all.ts` / `scripts/check-ci.ts` 在“仓库级门禁”段新增三条调用的确定性门禁；对外契约“`deno run -A scripts/check-all.ts` 全绿 = P5 完成”。

- [ ] **Step 1: 在 `scripts/check-all.ts` 与 `scripts/check-ci.ts` 追加门禁**

在 `scripts/check-all.ts` 的“仓库级门禁”段（`verify-capability-seams` 之后、`gen-event-catalog` 之前或之后均可）追加三行真实调用：

```ts
  await run(["deno", "run", "-A", "scripts/deploy/verify-build-server.ts"]);
  await run(["deno", "run", "-A", "scripts/deploy/verify-compose-server.ts"]);
  await run(["deno", "run", "-A", "scripts/deploy/verify-setup-thin.ts"]);
```

在 `scripts/check-ci.ts` 的“仓库级门禁”段追加同样三行。

- [ ] **Step 2: 运行三条门禁脚本**

Run:
```bash
deno run -A scripts/deploy/verify-build-server.ts
deno run -A scripts/deploy/verify-compose-server.ts
deno run -A scripts/deploy/verify-setup-thin.ts
```
Expected: 三条均输出 `✅ ...门禁通过`。

- [ ] **Step 3: 全量测试**

Run: `deno test -A --no-check scripts/deploy/verify-*_test.ts`
Expected: 全部 PASS（`verify-build-server_test`、`verify-compose-server_test`、`verify-setup-thin_test`）。

- [ ] **Step 4: 全量门禁（含文档链接）**

Run: `deno run -A scripts/check-all.ts`
Expected: 全绿（含 `verify-md-links.ts` 文档链接门禁、`deno fmt`/`deno lint`/`deno check` 以及 noj-core/llm-gateway/ui 模块检查）。若 `noj-cli/` 项目此前已由 P0–P4 创建，则其测试也一并通过。

- [ ] **Step 5: 执行真实构建冒烟（可选、linux/amd64 主机）**

Run: `NOJ_BUILD_SMOKE=1 bash scripts/deploy/test-build-server.sh`
Expected: 完成 `deno compile`，输出 `✅ noj-server 真实构建冒烟通过：<repo>/noj-core/bin/noj-server`。若当前主机非 linux/amd64 或不想触发慢编译，可跳过（门禁已覆盖脚本内容与目标约束）。

- [ ] **Step 6: 确认构建产物不入库**

Run: `git check-ignore noj-core/bin/noj-server`
Expected: 输出该路径（已被 `.gitignore` 忽略，构建产物不提交）。

- [ ] **Step 7: 提交**

```bash
jj split scripts/check-all.ts scripts/check-ci.ts
jj describe -m "ci(cli): P5 构建/Compose/setup 门禁接入全量检查"
```

> 说明：`noj-cli/README.md` 的 P5 补充仅在 P0–P4 已创建该文件时执行（与 prior 计划一致）；若尚无该文件，本步跳过，不为此新建独立文件。

---

## 状态

P5：新增 `deno compile` 生成 `noj-server`（linux/amd64）的构建脚本与 `deno task build:server`；
`docker-compose.prod.yml` 中镜像 `ghcr.io/neuro-oj/noj-core`、服务 `core` 改名为
`ghcr.io/neuro-oj/noj-server` / `server`，同步 `NUXT_API_BASE`、`depends_on` 与锚点；
`setup.sh` 改为仅下载/校验 `noj-cli-linux-amd64`（SHA-256）并 exec 的薄引导；
README / deploy/README / noj-docs 生产部署文档迁移到新命名与薄引导流程；
新增 `scripts/deploy/verify-build-server|compose-server|setup-thin` 三条门禁（含 Deno 测试）
接入 `check-all` / `check-ci`，并保留 `NOJ_BUILD_SMOKE=1 bash scripts/deploy/test-build-server.sh`
作为真实编译冒烟。

## 用法

```bash
# 构建 noj-server（linux/amd64）
cd noj-core && deno task build:server          # 或 bash scripts/build-server.sh

# 构建并验证版本（同门禁，含真实编译冒烟）
NOJ_BUILD_SMOKE=1 bash scripts/deploy/test-build-server.sh

# 仓库级门禁（P5 三项 + 文档链接 + 各模块检查）
deno run -A scripts/check-all.ts

# 一键部署（薄引导，下载并校验 noj-cli 后交由 noj-cli）
curl -fsSL https://raw.githubusercontent.com/Neuro-OJ/neuro-oj/main/setup.sh | bash
```

---

## Self-Review

### Spec 覆盖

- **添加 noj-server 的 deno compile 构建脚本（linux/amd64）** → Task 1：`noj-core/scripts/build-server.sh`（`--target x86_64-unknown-linux-gnu`、输出 `bin/noj-server`、入口 `src/main.ts`）+ `deno task build:server`；非 amd64 报错退出；产物 `noj-core/bin/` 加入 `.gitignore`。
- **更新 docker-compose.prod.yml：noj-core 镜像/服务改名 noj-server，内部引用同步** → Task 2：镜像 `ghcr.io/neuro-oj/noj-server`、服务 `core`→`server`、`NUXT_API_BASE: http://server:8000`、`ui.depends_on`→`server`、锚点 `x-server-env`，并配 `verify-compose-server` 门禁。
- **更新 setup.sh 为仅下载/校验 noj-cli 的薄引导** → Task 3：下载 `noj-cli-linux-amd64` + `.sha256`、`sha256sum` 校验（`NOJ_CLI_SHA256` 可覆盖）、exec `noj-cli`、删除对 `scripts/deploy/install.sh`/bootstrap 的引用，并配 `verify-setup-thin` 门禁。
- **更新 README、deploy/README、noj-docs 生产部署文档** → Task 4（README / deploy/README）、Task 5（production-deploy / production-secrets / cli），聚焦镜像/服务/二进制命名，源码目录与代码级标识按 glossary 保留。
- **写构建冒烟测试/文档链接检查** → Task 1 `test-build-server.sh`（`NOJ_BUILD_SMOKE=1` 真实编译）+ 三条 `verify-*` 门禁；Task 6 接入 `check-all.ts` / `check-ci.ts`；文档链接门禁复用 `scripts/verify-md-links.ts`。
- **Deno + TypeScript，仅 linux/amd64** → Global Constraints 声明 + Task 1/3 在脚本与 `setup.sh` 中强制 amd64。

### 占位符扫描

所有 `verify-*.ts` 门禁脚本、`_test.ts`、`build-server.sh`、`test-build-server.sh`、`setup.sh` 均为完整可直接落地代码；三个 `verify-*_test.ts` 均改用仓库根本地 `assert(cond, msg)` 辅助函数（与 `scripts/verify-md-links_test.ts` 一致），不依赖仓库根不存在的 `@std/assert` 裸映射。Task 5「其余大段保持不动」是改写范围说明，具体替换清单已逐条给出真实 `old → new` 文本。无“类似上文”“留待以后”等占位；每个代码步骤均有真实 Deno/bash 代码与真实命令。

### 类型一致性

- `verifyBuildServerScript(): string[]`（Task 1）Task 6 以 `deno run -A scripts/deploy/verify-build-server.ts` 复用，签名一致。
- `verifyComposeServer(): string[]`（Task 2）Task 6 复用一致；Task 4/5 按 Task 2 的契约（服务 `server`、镜像 `noj-server`、`server:8000`）改写文档，命名一致。
- `verifySetupThin(): string[]`（Task 3）Task 6 复用一致。
- 三个 verify 脚本均导出同名 `string[]` 函数并在 `import.meta.main` 下 `--check` 退出非零，供 `scripts/check-all.ts` 的 `run([...])` 直接调用。
- 环境变量：`NOJ_CLI_VERSION` / `NOJ_CLI_SHA256` / `NOJ_INSTALL_DIR` / `NOJ_BUILD_SMOKE` 在 Task 1/3/6 中拼写一致；`setup.sh` 引用 `NOJ_CLI_DOWNLOAD_BASE` 作为可选覆盖，仅 Task 3 使用。
- 边界说明（非漂移，为范围界定）：release.yml / staging 仍发布 `noj-core` 镜像，Global Constraints 已明确标为范围外、留后续阶段，P5 不改其 `string[]`/镜像名契约。
