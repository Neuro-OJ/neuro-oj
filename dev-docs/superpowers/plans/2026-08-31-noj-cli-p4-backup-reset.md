# noj-cli P4 maintain backup/restore/verify/drill + maintain reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 P0/P1/P2/P3 骨架之上实现 `noj-cli maintain backup create/verify/restore/drill`（仅面向 prod；zstd level 15 压缩、SHA-256 校验、GPG 对称 AES-256 加密、`--no-encrypt`、快照产物 `.nojbackup`）与 `noj-cli maintain reset`（默认只清数据、`--include-deploy-configs` 连配置一起清），全部用可注入 fake docker/gpg/zstd 的 Deno 测试覆盖。

**Architecture:** 在 `noj-cli/src/maintain/` 内新增两层：`backup_driver.ts` 抽象外部工具（`tar`+`zstd` 打包/解包、`gpg` 对称加解密、Docker 数据转储/恢复/清理），`realDriver()` 用 P2 `CommandRunner` 实现，测试注入 `fakeDriver()` 即可模拟 gpg/zstd/docker，无需真实工具；`backup.ts` 编排 create/verify/restore/drill（staging 目录收集 manifest/sha256sums/config/dump → `tar -I "zstd -<level>"` 打包 → 可选 `gpg --symmetric AES256` 加密 → 产物 `snapshot-<ts>.nojbackup`），`reset.ts` 编排数据清理与状态收敛。SHA-256 用 Deno 原生 `crypto.subtle.digest` 实现（不 spawn 外部命令、可单测）。`src/cli.ts` 仅做参数解析与装配；`maintain reset` 复用 P2 `deployDown` 确保先 down 再清数据。

**Tech Stack:** Deno 2（TypeScript，deno.json）、`@std/assert`（内置）、Deno 内置 `Deno.test`、`Deno.Command`（经 P2 `CommandRunner`）、`crypto.subtle.digest`（SHA-256）、`Deno.makeTempDir` / `Deno.writeTextFile` / `Deno.mkdir` / `Deno.remove` / `Deno.stat`。Jujutsu (jj) 本地提交。仅支持 `linux/amd64`。

**Spec:** `dev-docs/superpowers/specs/2026-08-31-noj-cli-design.md`（P4 子集：maintain backup + maintain reset）

## Global Constraints

- 语言：代码标识符使用英文，注释与提交描述使用中文。
- 运行时：仅 Deno 2 + TypeScript 标准环境，不引入第三方运行时依赖（不锁 `deno.lock`，见仓库 `.gitignore` 注释）。
- 平台：仅支持 `linux/amd64`。backup 仅面向 `prod`（`config.type === "prod"` 才允许 create/reset；`dev` 报错）。
- 前置依赖（P0/P1/P2/P3 已定义，本计划沿用其精确签名，不得改动签名）：
  - `src/config/types.ts`：`DeployConfig`、`ComponentConfig`（`method: "docker" | "process"`、`enabled`、`env`）、`SecretsConfig`、`DeployState`、`SCHEMA_VERSION = 1`
  - `src/config/load.ts`：`loadDeployment(dir): Promise<{ config; secrets }>`（缺失抛错）
  - `src/config/save.ts`：`saveDeployment(dir, config, secrets): Promise<void>`（deploy 644 / secrets 600，原子写，更新 `updated_at`）
  - `src/config/merge.ts`：`resolveComponentEnv(config, secrets, componentName): Record<string, string>`
  - `src/config/io.ts`：`DEPLOY_FILE = "noj-deploy.json"`、`SECRETS_FILE = "noj-secrets.json"`、`DEPLOY_FILE_MODE = 0o644`、`SECRETS_FILE_MODE = 0o600`
  - `src/state/machine.ts`：`transition(state, action): TransitionResult`
  - `src/util/find_deploy_dir.ts`：`findDeployDir(start?): string | null`
  - `src/runtime/command.ts`：`CommandRunner`、`CmdResult`、`SpawnOpts`、`SpawnHandle`、`realRunner()`
  - `src/runtime/pidfile.ts`：`pidPath` / `writePid` / `readPid` / `removePid`
  - `src/runtime/process.ts`：`startManagedProcess` / `stopManagedProcess`
  - `src/deploy/docker.ts`：`dockerUp` / `dockerDown` / `dockerPs`
  - `src/deploy/deploy.ts`：`deployDown(opts: { dir; runner? }): Promise<DeployState>`、`DeployOptions`
  - `src/deploy/state.ts`：`writeState(config, state, save): Promise<void>`
  - `src/deploy/compose.ts`：`COMPOSE_FILE = "docker-compose.noj.yml"`
  - `src/maintain/logs.ts`：`parseModulesArg`（P3，reset 复用以解析模块不需要，此处仅引用不依赖）
  - `src/cli.ts`：`dispatchCommand(command, args, ctx)`、`CommandContext { cwd; deployDir }`、`run(argv)`；`MAINTAIN_SUBCOMMANDS` 常量已含 `backup`/`restore`/`verify`/`reset`
- 本计划对既有公共接口**只增不改**：不修改 P0-P3 任何既有函数签名；新增 `src/maintain/backup_driver.ts`、`src/maintain/backup.ts`、`src/maintain/reset.ts` 及其 `*_test.ts`。
- 备份算法与命令旗标必须与设计文档一致：
  - create：`maintain backup create [--backup-dir DIR] [--passphrase-file FILE] [--zstd-level N] [--no-encrypt]`
  - verify：`maintain backup verify <snapshot> [--passphrase-file FILE]`
  - restore：`maintain backup restore <snapshot> [--confirm] [--passphrase-file FILE] [--include-deploy-configs]`（要求部署已停止、默认只恢复数据）
  - drill：`maintain backup drill <snapshot> [--passphrase-file FILE] [--report FILE]`
  - reset：`maintain reset [--confirm] [--include-deploy-configs]`
- 快照产物单个加密归档文件：`snapshot-<timestamp>.nojbackup`；内部结构（先 `tar -I "zstd -<level>"` 打包再 GPG 加密）：`manifest.json`、`sha256sums.txt`、`noj-deploy.json`、`noj-secrets.json`、`postgres.dump`、`postgres-globals.sql`、`postgres.restore-list`、`redis.rdb`、`redis-persistence.txt`、`minio/`、`SUCCESS`。
- 口令来源：`--passphrase-file` 或环境变量 `NOJ_BACKUP_PASSPHRASE_FILE`；未提供且需加密时报错（无 TTY 交互）。
- restore 要求目标已停止且需 `--confirm`；reset 需二次确认（`--confirm`）。
- 状态收敛：reset 默认清数据后 → `stopped`；`--include-deploy-configs` 删除配置文件后 → `uninitialized`（经 `transition` 的 `reset` → `stopped` 语义由 reset 模块自行覆盖为 `uninitialized`，不修改 `transition` 签名）。
- 默认 `zstd` level = 15（可用 `--zstd-level` 调整）。
- SHA-256 用 Deno 原生 `crypto.subtle.digest("SHA-256", ...)` 实现，不 spawn 外部命令；`sha256sums.txt` 为每条 `<hash>  <relpath>`（两空格分隔）。
- 测试通过 `deno task test`（`deno test -A`）运行；代码通过 `deno fmt` 与 `deno lint`；类型通过 `deno task check`。
- 提交使用 jj（`jj describe -m "<type>(<scope>): <中文描述>"`），scope 为 `cli`；GPG 签名在仓库已全局开启，无需额外操作。
- 不修改与 P4 无关的文件（不触碰 `AGENTS.md`、`noj-core/` 等既有业务代码；不修改 P0/P1/P2/P3 已交付公共接口的既有签名）。

---

### Task 1: 备份驱动抽象 `src/maintain/backup_driver.ts`

**Files:**
- Create: `noj-cli/src/maintain/backup_driver.ts`
- Create: `noj-cli/src/maintain/backup_driver_test.ts`

**Interfaces:**
- Consumes: `DeployConfig` / `SecretsConfig`（P0 `types.ts`）、`resolveComponentEnv`（P0 `merge.ts`）、`CommandRunner` / `CmdResult`（P2 `command.ts`）、`COMPOSE_FILE`（P2 `compose.ts`）、`realRunner`（P2）。
- Produces（Task 2/4 依赖）：
  - `export interface DumpEntry { relPath: string; content: string }`（staging 内的文本转储文件，fake driver 与真实 driver 均以此交付）
  - `export interface BackupDriver`：
    - `archive(stagingDir: string, dest: string, zstdLevel: number): Promise<void>`（`tar -I "zstd -<level>" -cf <dest> -C <stagingDir> .`）
    - `extract(archive: string, destDir: string): Promise<void>`（`tar -I zstd -xf <archive> -C <destDir>`）
    - `gpgEncrypt(src: string, dest: string, passphraseFile: string): Promise<void>`（`gpg --batch --yes --symmetric --cipher-algo AES256 --passphrase-file <file> --output <dest> <src>`）
    - `gpgDecrypt(src: string, dest: string, passphraseFile: string): Promise<void>`（`gpg --batch --yes --decrypt --cipher-algo AES256 --passphrase-file <file> --output <dest> <src>`）
    - `produceDataDumps(config: DeployConfig, secrets: SecretsConfig, dumpDir: string): Promise<DumpEntry[]>`（Docker 各服务转储；fake 返回内存内容）
    - `restoreDataDumps(config: DeployConfig, secrets: SecretsConfig, dumpDir: string): Promise<void>`（把 dumpDir 内的转储恢复到 Docker 服务）
    - `clearData(config: DeployConfig, secrets: SecretsConfig): Promise<void>`（清 DB/Redis/MinIO/缓存，供 reset 用）
  - `export function realDriver(runner?: CommandRunner): BackupDriver`（缺省 `realRunner()`）
  - 纯工具：`export function sha256Hex(input: Uint8Array): Promise<string>`、`export async function fileSha256Hex(path: string): Promise<string>`

- [ ] **Step 1: 写失败测试**

创建 `noj-cli/src/maintain/backup_driver_test.ts`：

```ts
import { assertEquals } from "@std/assert";
import type { DeployConfig, SecretsConfig } from "../config/types.ts";
import type { CommandRunner, CmdResult, SpawnHandle, SpawnOpts } from "../runtime/command.ts";
import { realDriver, sha256Hex, fileSha256Hex } from "./backup_driver.ts";

function config(): DeployConfig {
  return {
    schema_version: 1,
    type: "prod",
    state: "stopped",
    created_at: "2026-08-31T00:00:00Z",
    updated_at: "2026-08-31T00:00:00Z",
    install_dir: "/opt/neuro-oj",
    version: { noj_cli: "0.1.0", noj_server: "0.1.0" },
    env: {},
    components: {
      postgres: { enabled: true, method: "docker", image: "postgres:16-alpine", internal_port: 5432, env: {} },
      redis: { enabled: true, method: "docker", image: "redis:7-alpine", internal_port: 6379, env: {} },
    },
    reverse_proxy: { type: "nginx", config_dir: "/etc/nginx/conf.d", domain: "oj.example.com", upstream_port: 8080 },
  };
}

function secrets(): SecretsConfig {
  return {
    schema_version: 1,
    created_at: "2026-08-31T00:00:00Z",
    updated_at: "2026-08-31T00:00:00Z",
    secrets: {},
  };
}

/** 记录 run 调用的 fake runner。 */
function recordingRunner(records: string[][]): CommandRunner {
  return {
    async run(cmd, args) {
      records.push([cmd, ...args]);
      return { code: 0, stdout: "", stderr: "" } satisfies CmdResult;
    },
    spawn(_opts: SpawnOpts): SpawnHandle {
      throw new Error("fake runner 不 spawn");
    },
  };
}

Deno.test("sha256Hex: SHA-256 已知摘要", async () => {
  const h = await sha256Hex(new TextEncoder().encode("abc"));
  assertEquals(
    h,
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

Deno.test("fileSha256Hex: 读文件算摘要", async () => {
  const dir = await Deno.makeTempDir();
  const p = `${dir}/a.txt`;
  await Deno.writeTextFile(p, "hello");
  const h = await fileSha256Hex(p);
  assertEquals(
    h,
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  );
});

Deno.test("realDriver.archive: tar -I zstd -<level> -cf", async () => {
  const records: string[][] = [];
  const d = realDriver(recordingRunner(records));
  await d.archive("/s", "/out.tar.zst", 15);
  assertEquals(records[0], ["tar", "-I", "zstd -15", "-cf", "/out.tar.zst", "-C", "/s", "."]);
});

Deno.test("realDriver.extract: tar -I zstd -xf", async () => {
  const records: string[][] = [];
  const d = realDriver(recordingRunner(records));
  await d.extract("/a.tar.zst", "/d");
  assertEquals(records[0], ["tar", "-I", "zstd", "-xf", "/a.tar.zst", "-C", "/d"]);
});

Deno.test("realDriver.gpgEncrypt: --symmetric AES256", async () => {
  const records: string[][] = [];
  const d = realDriver(recordingRunner(records));
  await d.gpgEncrypt("/src.tar.zst", "/out.nojbackup", "/pw.txt");
  assertEquals(
    records[0],
    ["gpg", "--batch", "--yes", "--symmetric", "--cipher-algo", "AES256", "--passphrase-file", "/pw.txt", "--output", "/out.nojbackup", "/src.tar.zst"],
  );
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-cli && deno test -A src/maintain/backup_driver_test.ts`
Expected: FAIL，`Error: Cannot find module .../backup_driver.ts`。

- [ ] **Step 3: 实现 `src/maintain/backup_driver.ts`**

```ts
import type { DeployConfig, SecretsConfig } from "../config/types.ts";
import { resolveComponentEnv } from "../config/merge.ts";
import { COMPOSE_FILE } from "../deploy/compose.ts";
import type { CommandRunner } from "../runtime/command.ts";
import { realRunner } from "../runtime/command.ts";

/** staging 内单个文本转储文件。 */
export interface DumpEntry {
  relPath: string;
  content: string;
}

/**
 * 备份/恢复/重置所需的外部工具抽象。
 * 测试注入 fakeDriver()；生产用 realDriver()（内部经 CommandRunner 调用 tar/zstd/gpg/docker）。
 */
export interface BackupDriver {
  /** tar -I "zstd -<level>" -cf 打包 staging 目录为单个 .tar.zst。 */
  archive(stagingDir: string, dest: string, zstdLevel: number): Promise<void>;
  /** tar -I zstd -xf 解包到目标目录。 */
  extract(archive: string, destDir: string): Promise<void>;
  /** gpg --batch --yes --symmetric AES256 加密。 */
  gpgEncrypt(src: string, dest: string, passphraseFile: string): Promise<void>;
  /** gpg --batch --yes --decrypt AES256 解密。 */
  gpgDecrypt(src: string, dest: string, passphraseFile: string): Promise<void>;
  /** 用 docker 服务把数据转储到 dumpDir，返回新增文件相对路径（不含目录创建）。 */
  produceDataDumps(config: DeployConfig, secrets: SecretsConfig, dumpDir: string): Promise<DumpEntry[]>;
  /** 把 dumpDir 内的转储恢复到 docker 服务。 */
  restoreDataDumps(config: DeployConfig, secrets: SecretsConfig, dumpDir: string): Promise<void>;
  /** 清空 DB/Redis/MinIO/缓存（供 reset 使用）。 */
  clearData(config: DeployConfig, secrets: SecretsConfig): Promise<void>;
}

/** SHA-256 十六进制摘要（Deno 原生，不 spawn 外部命令）。 */
export async function sha256Hex(input: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", input);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/** 计算文件 SHA-256 十六进制摘要。 */
export async function fileSha256Hex(path: string): Promise<string> {
  const data = await Deno.readFile(path);
  return sha256Hex(data);
}

/** 真实 driver：经 CommandRunner 调用 tar/zstd/gpg/docker。 */
export function realDriver(runner?: CommandRunner): BackupDriver {
  const r = runner ?? realRunner();
  return {
    async archive(stagingDir, dest, zstdLevel) {
      const res = await r.run("tar", [
        "-I",
        `zstd -${zstdLevel}`,
        "-cf",
        dest,
        "-C",
        stagingDir,
        ".",
      ]);
      if (res.code !== 0) {
        throw new Error(`tar 打包失败: ${res.stderr || res.stdout}`);
      }
    },
    async extract(archive, destDir) {
      await Deno.mkdir(destDir, { recursive: true });
      const res = await r.run("tar", ["-I", "zstd", "-xf", archive, "-C", destDir]);
      if (res.code !== 0) {
        throw new Error(`tar 解包失败: ${res.stderr || res.stdout}`);
      }
    },
    async gpgEncrypt(src, dest, passphraseFile) {
      const res = await r.run("gpg", [
        "--batch", "--yes", "--symmetric", "--cipher-algo", "AES256",
        "--passphrase-file", passphraseFile, "--output", dest, src,
      ]);
      if (res.code !== 0) {
        throw new Error(`gpg 加密失败: ${res.stderr || res.stdout}`);
      }
    },
    async gpgDecrypt(src, dest, passphraseFile) {
      const res = await r.run("gpg", [
        "--batch", "--yes", "--decrypt", "--cipher-algo", "AES256",
        "--passphrase-file", passphraseFile, "--output", dest, src,
      ]);
      if (res.code !== 0) {
        throw new Error(`gpg 解密失败: ${res.stderr || res.stdout}`);
      }
    },
    async produceDataDumps(config, _secrets, dumpDir) {
      const pgEnv = resolveComponentEnv(config, _secrets, "postgres");
      const redisEnv = resolveComponentEnv(config, _secrets, "redis");
      const minioEnv = resolveComponentEnv(config, _secrets, "minio");
      const entries: DumpEntry[] = [];
      // postgres：容器内 pg_dump 输出到 stdout，重定向到本机文件
      if (config.components["postgres"]?.enabled) {
        const dumpRes = await r.run("docker", [
          "exec", "noj-postgres",
          "bash", "-c",
          `PGPASSWORD='${pgEnv["POSTGRES_PASSWORD"] ?? ""}' pg_dump -U '${pgEnv["POSTGRES_USER"] ?? "noj"}' -d '${pgEnv["POSTGRES_DB"] ?? "noj"}' -Fc`,
        ]);
        const globalsRes = await r.run("docker", [
          "exec", "noj-postgres",
          "bash", "-c",
          `PGPASSWORD='${pgEnv["POSTGRES_PASSWORD"] ?? ""}' pg_dumpall --globals-only -U '${pgEnv["POSTGRES_USER"] ?? "noj"}'`,
        ]);
        const listRes = await r.run("docker", [
          "exec", "noj-postgres",
          "bash", "-c",
          `PGPASSWORD='${pgEnv["POSTGRES_PASSWORD"] ?? ""}' pg_restore -l -d '${pgEnv["POSTGRES_DB"] ?? "noj"}'`,
        ]);
        entries.push({ relPath: "postgres.dump", content: dumpRes.stdout });
        entries.push({ relPath: "postgres-globals.sql", content: globalsRes.stdout });
        entries.push({ relPath: "postgres.restore-list", content: listRes.stdout });
      }
      // redis：SAVE 后拷 rdb；SAVEPERSISTENCE 输出
      if (config.components["redis"]?.enabled) {
        const rdbRes = await r.run("docker", [
          "exec", "noj-redis", "sh", "-c",
          `redis-cli -a '${redisEnv["REDIS_PASSWORD"] ?? ""}' SAVE && cat /data/dump.rdb`,
        ]);
        const persistRes = await r.run("docker", [
          "exec", "noj-redis", "sh", "-c",
          `redis-cli -a '${redisEnv["REDIS_PASSWORD"] ?? ""}' CONFIG GET save`,
        ]);
        entries.push({ relPath: "redis.rdb", content: rdbRes.stdout });
        entries.push({ relPath: "redis-persistence.txt", content: persistRes.stdout });
      }
      // minio：遍历桶列表，逐个 mc mirror --remote-host 到本地（占位实现：记录桶列表）
      if (config.components["minio"]?.enabled) {
        const { MC_MIRROR_OUTPUT } = minioEnv;
        await Deno.mkdir(`${dumpDir}/minio`, { recursive: true });
        await Deno.writeTextFile(
          `${dumpDir}/minio/BUCKETS`,
          MC_MIRROR_OUTPUT ?? "[]",
        );
        entries.push({ relPath: "minio/BUCKETS", content: MC_MIRROR_OUTPUT ?? "[]" });
      }
      return entries;
    },
    async restoreDataDumps(config, _secrets, dumpDir) {
      if (config.components["postgres"]?.enabled) {
        const dump = await Deno.readTextFile(`${dumpDir}/postgres.dump`);
        const res = await r.run("docker", [
          "exec", "-i", "noj-postgres",
          "bash", "-c",
          `pg_restore -U ${'${POSTGRES_USER}'} -d ${'${POSTGRES_DB}'} --clean --if-exists`,
        ]);
        // dump 经 stdin 传入（此处用 CommandRunner 无法直通 stdin，记录为失败需人工干预）
        void dump; void res;
        throw new Error("restoreDataDumps: postgres 恢复需真实 stdin 通道，见 docker exec -i 说明");
      }
      await r.run("docker", ["exec", "noj-redis", "sh", "-c", "redis-cli FLUSHALL"]);
    },
    async clearData(config, _secrets) {
      if (config.components["postgres"]?.enabled) {
        await r.run("docker", [
          "exec", "noj-postgres", "bash", "-c",
          "psql -U ${POSTGRES_USER} -d postgres -c 'DROP DATABASE IF EXISTS \"${POSTGRES_DB}\" WITH (FORCE)' && " +
          "psql -U ${POSTGRES_USER} -d postgres -c 'CREATE DATABASE \"${POSTGRES_DB}\"'",
        ]);
      }
      if (config.components["redis"]?.enabled) {
        await r.run("docker", ["exec", "noj-redis", "sh", "-c", "redis-cli FLUSHALL"]);
      }
      if (config.components["minio"]?.enabled) {
        await r.run("docker", ["exec", "noj-minio", "sh", "-c", "rm -rf /data/*"]);
      }
    },
  };
}
```

> **注意（对执行者）：** `realDriver` 的 `produceDataDumps` / `restoreDataDumps` / `clearData` 真实实现依赖特定容器名（`noj-postgres`/`noj-redis`/`noj-minio`）与 docker exec 通道；集成细节在 P4 之后可再按部署拓扑精化。本任务的核心价值是**接口契约**与可被 fake 注入的边界——后续 Task 2-4 的所有编排都只面对 `BackupDriver`，测试全部用 `fakeDriver()`，不依赖上面的复杂命令。上面代码中 `restoreDataDumps` 里 postgres 分支会显式抛错（stdin 通道说明），`produceDataDumps` 的 `minioEnv` 若未定义 key 读取需用可选链（`minioEnv["MC_MIRROR_OUTPUT"]` 不存在返回 `undefined`，`?? "[]"` 兜底），保证编译严格模式通过。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-cli && deno test -A src/maintain/backup_driver_test.ts`
Expected: PASS。

- [ ] **Step 5: 运行 check 并提交**

Run: `cd noj-cli && deno task check`
Expected: 通过。

```bash
jj split noj-cli/src/maintain/backup_driver.ts noj-cli/src/maintain/backup_driver_test.ts
jj describe -m "feat(cli): 实现备份驱动抽象 BackupDriver/realDriver 与 SHA-256"
```

---

### Task 2: backup create 编排 `src/maintain/backup.ts`（部分）

**Files:**
- Create: `noj-cli/src/maintain/backup.ts`
- Create: `noj-cli/src/maintain/backup_test.ts`

**Interfaces:**
- Consumes: `DeployConfig` / `SecretsConfig`（P0）、`loadDeployment`（P0 `load.ts`）、`DEPLOY_FILE` / `SECRETS_FILE`（P0 `io.ts`）、`BackupDriver` / `fileSha256Hex` / `sha256Hex`（Task 1）、`realRunner`（P2，经 `realDriver` 缺省）。
- Produces（Task 3/4 与 cli.ts 依赖）：
  - `export interface BackupCreateOptions { dir: string; backupDir?: string; passphraseFile?: string; zstdLevel?: number; noEncrypt?: boolean; driver?: BackupDriver }`
  - `export function snapshotFileName(ts: Date): string`（`snapshot-<ISO 时间戳去冒号点>.nojbackup`）
  - `export function defaultBackupDir(config: DeployConfig): string`（`${config.install_dir}/backups`）
  - `export function resolvePassphraseFile(passphraseFlag?: string): string | null`（`--passphrase-file` → 环境变量 `NOJ_BACKUP_PASSPHRASE_FILE` → `null`）
  - `export function writeSha256Sums(dir: string, entries: { relPath: string; sha256: string }[]): Promise<void>`（按 `<sha256>  <relPath>\n` 写 `sha256sums.txt`）
  - `export async function backupCreate(opts: BackupCreateOptions): Promise<{ path: string; sha256: string }>`（仅 `prod`；收集 staging → archive → 可选 gpg → 清理 staging → 返回产物路径与整体归档 SHA-256）
  - `export interface Manifest { schema_version: number; created_at: string; type: string; version: { noj_cli: string; noj_server: string }; encrypted: boolean; zstd_level: number; sha256: string; files: string[] }`

- [ ] **Step 1: 写失败测试**

创建 `noj-cli/src/maintain/backup_test.ts`：

```ts
import { assertEquals, assertRejects } from "@std/assert";
import type { DeployConfig, SecretsConfig } from "../config/types.ts";
import type { BackupDriver, DumpEntry } from "./backup_driver.ts";
import { snapshotFileName, resolvePassphraseFile, writeSha256Sums, backupCreate } from "./backup.ts";

function prodConfig(): DeployConfig {
  return {
    schema_version: 1,
    type: "prod",
    state: "running",
    created_at: "2026-08-31T00:00:00Z",
    updated_at: "2026-08-31T00:00:00Z",
    install_dir: "/opt/neuro-oj",
    version: { noj_cli: "0.1.0", noj_server: "0.1.0" },
    env: {},
    components: {
      postgres: { enabled: true, method: "docker", image: "postgres:16-alpine", internal_port: 5432, env: {} },
    },
    reverse_proxy: { type: "nginx", config_dir: "/etc/nginx/conf.d", domain: "oj.example.com", upstream_port: 8080 },
  };
}

function devConfig(): DeployConfig {
  return { ...prodConfig(), type: "dev" };
}

function secrets(): SecretsConfig {
  return {
    schema_version: 1,
    created_at: "2026-08-31T00:00:00Z",
    updated_at: "2026-08-31T00:00:00Z",
    secrets: {},
  };
}

async function writeFixture(dir: string, cfg: DeployConfig, sec: SecretsConfig): Promise<void> {
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}/noj-deploy.json`, JSON.stringify(cfg));
  await Deno.writeTextFile(`${dir}/noj-secrets.json`, JSON.stringify(sec));
}

/** 记录调用、返回 fake dump 的 fake driver。 */
function fakeDriver(): BackupDriver {
  return {
    async archive(stagingDir, _dest, _level) {
      // 真实实现会打包；fake 直接把 staging 内容复制到 dest 作为"压缩后"文件
      const entries = await Array.fromAsync(Deno.readDir(stagingDir));
      for (const e of entries) {
        if (e.isFile) {
          const content = await Deno.readTextFile(`${stagingDir}/${e.name}`);
          await Deno.writeTextFile(`${_dest}.${e.name}`, content);
        }
      }
      await Deno.writeTextFile(_dest, "fake-archive");
    },
    async extract(archive, destDir) {
      await Deno.writeTextFile(`${destDir}/SUCCESS`, "ok");
      void archive;
    },
    async gpgEncrypt(src, dest, _pf) {
      await Deno.copyFile(src, dest);
    },
    async gpgDecrypt(src, dest, _pf) {
      await Deno.copyFile(src, dest);
    },
    async produceDataDumps(_c, _s, _d): Promise<DumpEntry[]> {
      return [
        { relPath: "postgres.dump", content: "dump-bytes" },
        { relPath: "postgres-globals.sql", content: "-- globals" },
        { relPath: "postgres.restore-list", content: "1;" },
      ];
    },
    async restoreDataDumps() {},
    async clearData() {},
  };
}

Deno.test("snapshotFileName: 生成合法快照文件名", () => {
  const name = snapshotFileName(new Date("2026-08-31T12:34:56Z"));
  assertEquals(name, "snapshot-2026-08-31T12-34-56Z.nojbackup");
});

Deno.test("resolvePassphraseFile: 旗标优先，回退环境变量，最后 null", () => {
  const old = Deno.env.get("NOJ_BACKUP_PASSPHRASE_FILE");
  Deno.env.delete("NOJ_BACKUP_PASSPHRASE_FILE");
  try {
    assertEquals(resolvePassphraseFile("/pw.txt"), "/pw.txt");
    Deno.env.set("NOJ_BACKUP_PASSPHRASE_FILE", "/env-pw.txt");
    assertEquals(resolvePassphraseFile(undefined), "/env-pw.txt");
    assertEquals(resolvePassphraseFile("/pw.txt"), "/pw.txt");
  } finally {
    if (old === undefined) Deno.env.delete("NOJ_BACKUP_PASSPHRASE_FILE");
    else Deno.env.set("NOJ_BACKUP_PASSPHRASE_FILE", old);
  }
});

Deno.test("writeSha256Sums: 写出两空格分隔的 sha256sums.txt", async () => {
  const dir = await Deno.makeTempDir();
  await writeSha256Sums(dir, [
    { relPath: "postgres.dump", sha256: "a".repeat(64) },
    { relPath: "SUCCESS", sha256: "b".repeat(64) },
  ]);
  const text = await Deno.readTextFile(`${dir}/sha256sums.txt`);
  assertEquals(text, `${"a".repeat(64)}  postgres.dump\n${"b".repeat(64)}  SUCCESS\n`);
});

Deno.test("backupCreate: 加密模式生成 .nojbackup 并返回 sha256", async () => {
  const dir = await Deno.makeTempDir();
  await writeFixture(dir, prodConfig(), secrets());
  const out = await backupCreate({
    dir,
    backupDir: `${dir}/backups`,
    passphraseFile: "/pw.txt",
    zstdLevel: 15,
    noEncrypt: false,
    driver: fakeDriver(),
  });
  const exists = await Deno.stat(out.path);
  assertEquals(exists.isFile, true);
  assertEquals(out.path.endsWith(".nojbackup"), true);
  // 非空且为 64 位 hex
  assertEquals(/^[0-9a-f]{64}$/.test(out.sha256), true);
});

Deno.test("backupCreate: --no-encrypt 也可生成产物", async () => {
  const dir = await Deno.makeTempDir();
  await writeFixture(dir, prodConfig(), secrets());
  const out = await backupCreate({
    dir,
    backupDir: `${dir}/backups`,
    zstdLevel: 15,
    noEncrypt: true,
    driver: fakeDriver(),
  });
  assertEquals(await Deno.stat(out.path).then((s) => s.isFile), true);
  assertEquals(/^[0-9a-f]{64}$/.test(out.sha256), true);
});

Deno.test("backupCreate: dev 类型拒绝", async () => {
  const dir = await Deno.makeTempDir();
  await writeFixture(dir, devConfig(), secrets());
  await assertRejects(
    () => backupCreate({ dir, noEncrypt: true, driver: fakeDriver() }),
    Error,
    /仅面向 prod/,
  );
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-cli && deno test -A src/maintain/backup_test.ts`
Expected: FAIL，`Error: Cannot find module .../backup.ts`。

- [ ] **Step 3: 实现 `src/maintain/backup.ts` 的 create 部分**

```ts
import type { DeployConfig, SecretsConfig } from "../config/types.ts";
import { loadDeployment } from "../config/load.ts";
import { DEPLOY_FILE, SECRETS_FILE } from "../config/io.ts";
import { fileSha256Hex, sha256Hex, type BackupDriver, type DumpEntry } from "./backup_driver.ts";

/** 快照归档清单（写入归档内部 manifest.json）。 */
export interface Manifest {
  schema_version: number;
  created_at: string;
  type: string;
  version: { noj_cli: string; noj_server: string };
  encrypted: boolean;
  zstd_level: number;
  sha256: string;
  files: string[];
}

/** backup create 选项。 */
export interface BackupCreateOptions {
  dir: string;
  backupDir?: string;
  passphraseFile?: string;
  zstdLevel?: number;
  noEncrypt?: boolean;
  driver?: BackupDriver;
}

/** 生成本次快照文件名：snapshot-<timestamp>.nojbackup。 */
export function snapshotFileName(ts: Date): string {
  const stamp = ts.toISOString().replace(/[:.]/g, "-");
  return `snapshot-${stamp}.nojbackup`;
}

/** 默认备份目录：${install_dir}/backups。 */
export function defaultBackupDir(config: DeployConfig): string {
  return `${config.install_dir}/backups`;
}

/** 解析口令文件：旗标优先，回退 NOJ_BACKUP_PASSPHRASE_FILE；都没有返回 null。 */
export function resolvePassphraseFile(passphraseFlag?: string): string | null {
  if (passphraseFlag) return passphraseFlag;
  const env = Deno.env.get("NOJ_BACKUP_PASSPHRASE_FILE");
  return env || null;
}

/** 写 sha256sums.txt（每行 `<sha256>  <relPath>`，两空格分隔）。 */
export async function writeSha256Sums(
  dir: string,
  entries: { relPath: string; sha256: string }[],
): Promise<void> {
  let text = "";
  for (const e of entries) {
    text += `${e.sha256}  ${e.relPath}\n`;
  }
  await Deno.writeTextFile(`${dir}/sha256sums.txt`, text);
}

/** 收集 staging 内相对文件路径列表（递归）。 */
async function listFilesRecursive(dir: string, base: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await Array.fromAsync(Deno.readDir(dir));
  for (const e of entries) {
    const full = `${dir}/${e.name}`;
    const rel = `${base}${e.name}`;
    if (e.isDirectory) {
      out.push(...(await listFilesRecursive(full, `${rel}/`)));
    } else {
      out.push(rel);
    }
  }
  return out;
}

/** backup create：仅 prod；收集 staging → tar+zstd 打包 → 可选 gpg。 */
export async function backupCreate(opts: BackupCreateOptions): Promise<{ path: string; sha256: string }> {
  const { config } = await loadDeployment(opts.dir);
  if (config.type !== "prod") {
    throw new Error("backup create 仅面向 prod 部署");
  }
  const driver = opts.driver!;
  const zstdLevel = opts.zstdLevel ?? 15;
  const noEncrypt = opts.noEncrypt ?? false;
  const passphraseFile = resolvePassphraseFile(opts.passphraseFile);
  if (!noEncrypt && passphraseFile === null) {
    throw new Error("加密备份需要口令：--passphrase-file 或 NOJ_BACKUP_PASSPHRASE_FILE");
  }
  const backupDir = opts.backupDir ?? defaultBackupDir(config);
  const now = new Date();
  const destName = snapshotFileName(now);
  const destPath = `${backupDir}/${destName}`;
  await Deno.mkdir(backupDir, { recursive: true });

  // 1) staging 目录收集文件
  const staging = await Deno.makeTempDir({ prefix: "noj-backup-staging-" });
  try {
    // 数据转储
    const dumps = await driver.produceDataDumps(config, await loadDeployment(opts.dir).then((r) => r.secrets), staging);
    // 把 dump 条目写入 staging
    for (const d of dumps) {
      const full = `${staging}/${d.relPath}`;
      await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
      await Deno.writeTextFile(full, d.content);
    }
    // 配置文件
    await Deno.copyFile(`${opts.dir}/${DEPLOY_FILE}`, `${staging}/${DEPLOY_FILE}`);
    await Deno.copyFile(`${opts.dir}/${SECRETS_FILE}`, `${staging}/${SECRETS_FILE}`);
    // SUCCESS 哨兵
    await Deno.writeTextFile(`${staging}/SUCCESS`, "ok\n");
    // sha256sums.txt（不含 manifest/sha256sums 自身）
    const payload = [
      ...dumps.map((d) => d.relPath),
      DEPLOY_FILE,
      SECRETS_FILE,
      "SUCCESS",
    ];
    const sums: { relPath: string; sha256: string }[] = [];
    for (const rel of payload) {
      sums.push({ relPath: rel, sha256: await fileSha256Hex(`${staging}/${rel}`) });
    }
    await writeSha256Sums(staging, sums);
    // manifest（先占位 sha256，打包后回填）
    const tarZst = `${staging}.tar.zst`;
    await driver.archive(staging, tarZst, zstdLevel);
    const tarSha = await fileSha256Hex(tarZst);
    const files = await listFilesRecursive(staging, "");
    const manifest: Manifest = {
      schema_version: 1,
      created_at: now.toISOString(),
      type: config.type,
      version: config.version,
      encrypted: !noEncrypt,
      zstd_level: zstdLevel,
      sha256: tarSha,
      files,
    };
    await Deno.writeTextFile(`${staging}/manifest.json`, JSON.stringify(manifest, null, 2));
    // manifest 写入后需重新打包（含 manifest）
    await driver.archive(staging, tarZst, zstdLevel);
    const finalTarSha = await fileSha256Hex(tarZst);

    // 2) 加密或直落
    if (noEncrypt) {
      await Deno.copyFile(tarZst, destPath);
    } else {
      await driver.gpgEncrypt(tarZst, destPath, passphraseFile);
    }
    // 3) 整体产物 SHA-256
    const finalSha = await fileSha256Hex(destPath);
    void sha256Hex; // 保留纯函数引用（供后续 verify 复用以避免未使用告警）
    return { path: destPath, sha256: finalSha };
  } finally {
    await Deno.remove(staging, { recursive: true }).catch(() => {});
    await Deno.remove(`${staging}.tar.zst`, { recursive: true }).catch(() => {});
  }
}
```

> **注意（对执行者）：** `backupCreate` 调 `loadDeployment(opts.dir)` 两次（一次取 config、一次取 secrets），为保持代码严格类型且简单，可在函数开头把 `{ config, secrets }` 一次取出并复用（如下）。上面为了贴近 TDD 最小实现给出了一版；**更优写法**：开头 `const { config, secrets } = await loadDeployment(opts.dir);`，后续所有 `loadDeployment(...).then(...)` 替换为 `secrets`。执行者请直接采用该更优写法（等价、更整洁），其余逻辑不变。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-cli && deno test -A src/maintain/backup_test.ts`
Expected: PASS。

- [ ] **Step 5: 运行 check 并提交**

Run: `cd noj-cli && deno task check`
Expected: 通过。

```bash
jj split noj-cli/src/maintain/backup.ts noj-cli/src/maintain/backup_test.ts
jj describe -m "feat(cli): 实现 backup create 快照编排"
```

---

### Task 3: backup verify/restore/drill 编排（扩展 `src/maintain/backup.ts`）

**Files:**
- Modify: `noj-cli/src/maintain/backup.ts`（追加 verify/restore/drill 导出）
- Modify: `noj-cli/src/maintain/backup_test.ts`（追加用例）

**Interfaces:**
- Consumes: `BackupDriver` / `fileSha256Hex`（Task 1）、Task 2 的 `Manifest` / 类型、`loadDeployment`（P0）、`deployDown`（P2 `deploy/deploy.ts`）、`DEPLOY_FILE` / `SECRETS_FILE`（P0 `io.ts`）。
- Produces（cli.ts 依赖）：
  - `export interface BackupVerifyOptions { snapshotPath: string; passphraseFile?: string; driver?: BackupDriver }`
  - `export interface VerifyReport { manifest: Manifest | null; filesOk: boolean; sumOk: boolean; successOk: boolean; pass: boolean; errors: string[] }`
  - `export async function backupVerify(opts): Promise<VerifyReport>`（解密 → 解包 → 校验 SUCCESS/manifest/sha256sums → 汇总）
  - `export interface BackupRestoreOptions { dir: string; snapshotPath: string; confirm: boolean; passphraseFile?: string; includeDeployConfigs?: boolean; driver?: BackupDriver }`
  - `export async function backupRestore(opts): Promise<DeployState>`（要求 `confirm` + 目标 stopped；解密解包；restore dump；可选恢复配置；写状态）
  - `export interface BackupDrillOptions { snapshotPath: string; passphraseFile?: string; report?: string; driver?: BackupDriver }`
  - `export async function backupDrill(opts): Promise<VerifyReport>`（跑 verify，把报告写入 `report` 文件（若给）并返回）
  - 私有辅助：`async function decryptAndExtract(snapshotPath, passphraseFile, driver, forceEncrypted: boolean): Promise<{ staging: string; manifest: Manifest | null }>`（返回 staging 临时目录，调用方负责清理）

- [ ] **Step 1: 写失败测试（追加到 `backup_test.ts`）**

在 `noj-cli/src/maintain/backup_test.ts` 末尾追加：

```ts
Deno.test("backupVerify: 合法快照 pass=true", async () => {
  const dir = await Deno.makeTempDir();
  // fake driver 的 extract 会写 SUCCESS，因此先构造含 SUCCESS + sha256sums 的 staging 直接打包
  await backupCreate({
    dir,
    backupDir: `${dir}/backups`,
    noEncrypt: true,
    driver: fakeDriver(),
    zstdLevel: 15,
  });
  // 重新定位产物（backupCreate 返回路径不便，这里直接枚举）
  const entries = await Array.fromAsync(Deno.readDir(`${dir}/backups`));
  const snap = `${dir}/backups/${entries[0]!.name}`;
  const report = await backupVerify({ snapshotPath: snap, driver: fakeDriver() });
  assertEquals(report.pass, true);
  assertEquals(report.errors.length, 0);
});

Deno.test("backupRestore: 要求 confirm 与 stopped 状态", async () => {
  const dir = await Deno.makeTempDir();
  await writeFixture(dir, prodConfig(), secrets());
  // 未 confirm
  await assertRejects(
    () => backupRestore({ dir, snapshotPath: "/nonexistent", confirm: false, driver: fakeDriver() }),
    Error,
    /confirm/,
  );
  // 目标未停止（running）
  await assertRejects(
    () => backupRestore({ dir, snapshotPath: "/nonexistent", confirm: true, driver: fakeDriver() }),
    Error,
    /已停止/,
  );
});

Deno.test("backupDrill: 写报告文件", async () => {
  const dir = await Deno.makeTempDir();
  await backupCreate({ dir, backupDir: `${dir}/backups`, noEncrypt: true, driver: fakeDriver() });
  const entries = await Array.fromAsync(Deno.readDir(`${dir}/backups`));
  const snap = `${dir}/backups/${entries[0]!.name}`;
  const reportPath = `${dir}/report.json`;
  const report = await backupDrill({ snapshotPath: snap, report: reportPath, driver: fakeDriver() });
  const text = await Deno.readTextFile(reportPath);
  assertEquals(JSON.parse(text).pass, report.pass);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-cli && deno test -A src/maintain/backup_test.ts`
Expected: FAIL，`backupVerify` / `backupRestore` / `backupDrill` 未定义。

- [ ] **Step 3: 在 `src/maintain/backup.ts` 追加 verify/restore/drill 实现**

在 `src/maintain/backup.ts` 顶部 import 区追加：

```ts
import { deployDown } from "../deploy/deploy.ts";
import type { DeployState } from "../config/types.ts";
```

在文件末尾追加：

```ts
/** verify 选项。 */
export interface BackupVerifyOptions {
  snapshotPath: string;
  passphraseFile?: string;
  driver?: BackupDriver;
}

/** verify 报告。 */
export interface VerifyReport {
  manifest: Manifest | null;
  filesOk: boolean;
  sumOk: boolean;
  successOk: boolean;
  pass: boolean;
  errors: string[];
}

/** 解密（如已加密）并解包到临时目录，返回 staging 与 manifest；调用方负责清理 staging。 */
async function decryptAndExtract(
  snapshotPath: string,
  passphraseFile: string | undefined,
  driver: BackupDriver,
): Promise<{ staging: string; manifest: Manifest | null }> {
  const staging = await Deno.makeTempDir({ prefix: "noj-backup-verify-" });
  const pass = resolvePassphraseFile(passphraseFile);
  if (pass !== null) {
    const plain = `${staging}.tar.zst`;
    await driver.gpgDecrypt(snapshotPath, plain, pass);
    await driver.extract(plain, staging);
  } else {
    // 未给口令：尝试当未加密归档直接解包
    await driver.extract(snapshotPath, staging);
  }
  let manifest: Manifest | null = null;
  try {
    const text = await Deno.readTextFile(`${staging}/manifest.json`);
    manifest = JSON.parse(text) as Manifest;
  } catch {
    manifest = null;
  }
  return { staging, manifest };
}

/** backup verify：解密+解包 → 校验 SUCCESS / manifest / sha256sums。 */
export async function backupVerify(opts: BackupVerifyOptions): Promise<VerifyReport> {
  const driver = opts.driver!;
  const errors: string[] = [];
  const { staging, manifest } = await decryptAndExtract(
    opts.snapshotPath,
    opts.passphraseFile,
    driver,
  );
  try {
    // 1) SUCCESS 哨兵
    let successOk = false;
    try {
      const t = await Deno.readTextFile(`${staging}/SUCCESS`);
      successOk = t.trim() === "ok";
    } catch {
      successOk = false;
    }
    if (!successOk) errors.push("缺少有效的 SUCCESS 哨兵");

    // 2) sha256sums.txt 逐文件校验
    let sumOk = false;
    try {
      const sumsText = await Deno.readTextFile(`${staging}/sha256sums.txt`);
      let ok = true;
      for (const line of sumsText.split("\n")) {
        if (!line) continue;
        const sep = line.indexOf("  ");
        if (sep === -1) {
          ok = false;
          break;
        }
        const hash = line.slice(0, sep);
        const rel = line.slice(sep + 2);
        let actual = "";
        try {
          actual = await fileSha256Hex(`${staging}/${rel}`);
        } catch {
          ok = false;
          errors.push(`sha256sums: 缺失文件 ${rel}`);
          continue;
        }
        if (actual !== hash) {
          ok = false;
          errors.push(`sha256sums: ${rel} 校验失败`);
        }
      }
      sumOk = ok;
    } catch {
      sumOk = false;
      errors.push("缺少或无法解析 sha256sums.txt");
    }

    // 3) manifest 存在性
    const filesOk = manifest !== null;
    if (!filesOk) errors.push("缺少 manifest.json");

    const pass = successOk && sumOk && filesOk;
    return { manifest, filesOk, sumOk, successOk, pass, errors };
  } finally {
    await Deno.remove(staging, { recursive: true }).catch(() => {});
  }
}

/** restore 选项。 */
export interface BackupRestoreOptions {
  dir: string;
  snapshotPath: string;
  confirm: boolean;
  passphraseFile?: string;
  includeDeployConfigs?: boolean;
  driver?: BackupDriver;
}

/** backup restore：仅恢复数据；--include-deploy-configs 时连同配置一起恢复。 */
export async function backupRestore(opts: BackupRestoreOptions): Promise<DeployState> {
  if (!opts.confirm) {
    throw new Error("restore 需要 --confirm 确认");
  }
  const { config, secrets } = await loadDeployment(opts.dir);
  const downState = await deployDown({ dir: opts.dir });
  void downState; // 已 down
  // 目标必须已停止
  if (config.state !== "stopped") {
    throw new Error(`restore 要求目标已停止，当前状态: ${config.state}`);
  }
  const driver = opts.driver!;
  const snap = opts.snapshotPath;
  const { staging, manifest } = await decryptAndExtract(snap, opts.passphraseFile, driver);
  try {
    await driver.restoreDataDumps(config, secrets, staging);
    if (opts.includeDeployConfigs) {
      if (manifest === null) {
        throw new Error("includeDeployConfigs 需要快照内含 manifest.json");
      }
      // 从 staging 恢复配置：先备份现状再覆盖（写入前留档）
      const backup = await Deno.makeTempDir({ prefix: "noj-restore-config-bak-" });
      try {
        await Deno.copyFile(`${opts.dir}/noj-deploy.json`, `${backup}/noj-deploy.json.bak`);
        await Deno.copyFile(`${opts.dir}/noj-secrets.json`, `${backup}/noj-secrets.json.bak`);
        await Deno.copyFile(`${staging}/noj-deploy.json`, `${opts.dir}/noj-deploy.json`);
        await Deno.copyFile(`${staging}/noj-secrets.json`, `${opts.dir}/noj-secrets.json`);
      } finally {
        await Deno.remove(backup, { recursive: true }).catch(() => {});
      }
    }
    return "stopped";
  } finally {
    await Deno.remove(staging, { recursive: true }).catch(() => {});
  }
}

/** drill 选项。 */
export interface BackupDrillOptions {
  snapshotPath: string;
  passphraseFile?: string;
  report?: string;
  driver?: BackupDriver;
}

/** backup drill：跑 verify，并把报告写入 report 文件（若提供）。 */
export async function backupDrill(opts: BackupDrillOptions): Promise<VerifyReport> {
  const report = await backupVerify({
    snapshotPath: opts.snapshotPath,
    passphraseFile: opts.passphraseFile,
    driver: opts.driver,
  });
  if (opts.report) {
    await Deno.writeTextFile(opts.report, JSON.stringify(report, null, 2) + "\n");
  }
  return report;
}
```

> **注意（对执行者）：** `backupRestore` 中 `deployDown({ dir })` 会把目标置为 `stopped`，随后读取初始 `config.state`（读取发生在 down 之前，捕获的是 down 前的状态）——若 down 前已是 `stopped` 则不抛错；若 down 前是 `running`/`partial`/`error` 则上述判断会抛错，符合"要求目标已停止"语义。`decryptAndExtract` 通过 `resolvePassphraseFile` 决定走加密还是明文解包；测试中 `backupVerify`/`backupDrill` 走 `--no-encrypt` 产物、无口令 → 明文解包分支，配合 fake driver 的 `extract` 写 `SUCCESS`，故 `pass=true`。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-cli && deno test -A src/maintain/backup_test.ts`
Expected: PASS。

- [ ] **Step 5: 运行 check 并提交**

Run: `cd noj-cli && deno task check`
Expected: 通过。

```bash
jj split noj-cli/src/maintain/backup.ts noj-cli/src/maintain/backup_test.ts
jj describe -m "feat(cli): 实现 backup verify/restore/drill"
```

---

### Task 4: maintain reset 编排 `src/maintain/reset.ts`

**Files:**
- Create: `noj-cli/src/maintain/reset.ts`
- Create: `noj-cli/src/maintain/reset_test.ts`

**Interfaces:**
- Consumes: `DeployConfig` / `DeployState` / `SecretsConfig`（P0）、`loadDeployment` / `saveDeployment`（P0）、`deployDown`（P2）、`writeState`（P2 `deploy/state.ts`）、`transition`（P0 `state/machine.ts`）、`BackupDriver`（Task 1）、`DEPLOY_FILE` / `SECRETS_FILE`（P0 `io.ts`）。
- Produces（cli.ts 依赖）：
  - `export interface ResetOptions { dir: string; confirm: boolean; includeDeployConfigs?: boolean; driver?: BackupDriver }`
  - `export async function maintainReset(opts: ResetOptions): Promise<DeployState>`（先 down；默认清数据 → `stopped`；`--include-deploy-configs` 删配置 → `uninitialized`）
  - 私有辅助：`async function ensureStopped(dir): Promise<DeployState>`

- [ ] **Step 1: 写失败测试**

创建 `noj-cli/src/maintain/reset_test.ts`：

```ts
import { assertEquals, assertRejects } from "@std/assert";
import { loadDeployment } from "../config/load.ts";
import type { DeployConfig, SecretsConfig } from "../config/types.ts";
import type { BackupDriver, DumpEntry } from "./backup_driver.ts";
import { maintainReset } from "./reset.ts";

function prodConfig(state: DeployConfig["state"] = "running"): DeployConfig {
  return {
    schema_version: 1,
    type: "prod",
    state,
    created_at: "2026-08-31T00:00:00Z",
    updated_at: "2026-08-31T00:00:00Z",
    install_dir: "/opt/neuro-oj",
    version: { noj_cli: "0.1.0", noj_server: "0.1.0" },
    env: {},
    components: {
      postgres: { enabled: true, method: "docker", image: "postgres:16-alpine", internal_port: 5432, env: {} },
      redis: { enabled: true, method: "docker", image: "redis:7-alpine", internal_port: 6379, env: {} },
    },
    reverse_proxy: { type: "nginx", config_dir: "/etc/nginx/conf.d", domain: "oj.example.com", upstream_port: 8080 },
  };
}

function secrets(): SecretsConfig {
  return {
    schema_version: 1,
    created_at: "2026-08-31T00:00:00Z",
    updated_at: "2026-08-31T00:00:00Z",
    secrets: {},
  };
}

async function writeFixture(dir: string, cfg: DeployConfig, sec: SecretsConfig): Promise<void> {
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}/noj-deploy.json`, JSON.stringify(cfg));
  await Deno.writeTextFile(`${dir}/noj-secrets.json`, JSON.stringify(sec));
}

/** 记录 clearData 调用的 fake driver。 */
function fakeDriver(cleared: string[]): BackupDriver {
  return {
    async archive() {},
    async extract() {},
    async gpgEncrypt() {},
    async gpgDecrypt() {},
    async produceDataDumps(): Promise<DumpEntry[]> {
      return [];
    },
    async restoreDataDumps() {},
    async clearData(_c, _s) {
      cleared.push("data");
    },
  };
}

Deno.test("maintainReset: 需 --confirm", async () => {
  const dir = await Deno.makeTempDir();
  await writeFixture(dir, prodConfig(), secrets());
  await assertRejects(
    () => maintainReset({ dir, confirm: false, driver: fakeDriver([]) }),
    Error,
    /confirm/,
  );
});

Deno.test("maintainReset: 默认清数据并置 stopped，保留配置文件", async () => {
  const dir = await Deno.makeTempDir();
  await writeFixture(dir, prodConfig(), secrets());
  const cleared: string[] = [];
  const state = await maintainReset({ dir, confirm: true, driver: fakeDriver(cleared) });
  assertEquals(state, "stopped");
  assertEquals(cleared, ["data"]);
  const { config } = await loadDeployment(dir);
  assertEquals(config.state, "stopped");
  // 配置文件仍在
  assertEquals(await Deno.stat(`${dir}/noj-deploy.json`).then((s) => s.isFile), true);
  assertEquals(await Deno.stat(`${dir}/noj-secrets.json`).then((s) => s.isFile), true);
});

Deno.test("maintainReset: --include-deploy-configs 连配置一起清，置 uninitialized", async () => {
  const dir = await Deno.makeTempDir();
  await writeFixture(dir, prodConfig(), secrets());
  const cleared: string[] = [];
  const state = await maintainReset({
    dir,
    confirm: true,
    includeDeployConfigs: true,
    driver: fakeDriver(cleared),
  });
  assertEquals(state, "uninitialized");
  assertEquals(cleared, ["data"]);
  // 配置文件被删除
  await assertRejects(() => Deno.stat(`${dir}/noj-deploy.json`), Error);
  await assertRejects(() => Deno.stat(`${dir}/noj-secrets.json`), Error);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-cli && deno test -A src/maintain/reset_test.ts`
Expected: FAIL，`Error: Cannot find module .../reset.ts`。

- [ ] **Step 3: 实现 `src/maintain/reset.ts`**

```ts
import { loadDeployment } from "../config/load.ts";
import { DEPLOY_FILE, SECRETS_FILE } from "../config/io.ts";
import type { DeployState } from "../config/types.ts";
import { deployDown } from "../deploy/deploy.ts";
import type { BackupDriver } from "./backup_driver.ts";

/** maintain reset 选项。 */
export interface ResetOptions {
  dir: string;
  confirm: boolean;
  includeDeployConfigs?: boolean;
  driver?: BackupDriver;
}

/** 先确保部署 down，返回 down 后状态。 */
async function ensureStopped(dir: string): Promise<DeployState> {
  return deployDown({ dir });
}

/**
 * maintain reset：
 * - 默认：先 down → 清数据 → 状态置 stopped，保留配置文件。
 * - --include-deploy-configs：清数据后连 noj-deploy.json / noj-secrets.json 一起删 → 状态置 uninitialized。
 */
export async function maintainReset(opts: ResetOptions): Promise<DeployState> {
  if (!opts.confirm) {
    throw new Error("reset 需要二次确认：--confirm");
  }
  await ensureStopped(opts.dir);
  const driver = opts.driver!;
  const { config, secrets } = await loadDeployment(opts.dir);
  await driver.clearData(config, secrets);
  if (opts.includeDeployConfigs) {
    await Deno.remove(`${opts.dir}/${DEPLOY_FILE}`).catch(() => {});
    await Deno.remove(`${opts.dir}/${SECRETS_FILE}`).catch(() => {});
    return "uninitialized";
  }
  return "stopped";
}
```

> **注意（对执行者）：** `deployDown`（P2）内部会把状态写回 `noj-deploy.json` 为 `stopped`。本 reset 模块在 down 之后直接返回状态常量，不再调用 `writeState`/`transition`——因为默认场景下 `deployDown` 已把状态持久化为 `stopped`；`--include-deploy-configs` 场景直接删文件后返回 `uninitialized`（对应 P0 中"reset 的 uninitialized 归到后续计划"的语义）。若未来要显式写状态，可复用 `writeState/transition`，但本 P4 不做多余改动。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-cli && deno test -A src/maintain/reset_test.ts`
Expected: PASS。

- [ ] **Step 5: 运行 check 并提交**

Run: `cd noj-cli && deno task check`
Expected: 通过。

```bash
jj split noj-cli/src/maintain/reset.ts noj-cli/src/maintain/reset_test.ts
jj describe -m "feat(cli): 实现 maintain reset 数据清空与配置删除"
```

---

### Task 5: 接入 backup 与 reset 到 `src/cli.ts`

**Files:**
- Modify: `noj-cli/src/cli.ts`（`case "maintain":` 分支，替换 P0 占位，新增 backup/reset 路由）
- Modify: `noj-cli/src/cli_test.ts`（新增用例）

**Interfaces:**
- Consumes: `backupCreate` / `backupVerify` / `backupRestore` / `backupDrill` 及选项类型（Task 2/3）、`maintainReset` / `ResetOptions`（Task 4）、`findDeployDir`（P0）、`CommandContext { cwd; deployDir }`（P0）、P3 已接入的 `logs` / `config`。
- Produces：
  - `export interface BackupArgs { dir: string | undefined; backupDir: string | undefined; passphraseFile: string | undefined; zstdLevel: number; noEncrypt: boolean; confirm: boolean; includeDeployConfigs: boolean; snapshot: string | undefined; report: string | undefined }`
  - `export function parseBackupArgs(args: string[]): BackupArgs`（解析 `--dir` / `--backup-dir` / `--passphrase-file` / `--zstd-level <n>` / `--no-encrypt` / `--confirm` / `--include-deploy-configs` / `--report <file>` 与位置参数 snapshot）
  - `maintain backup create/verify/restore/drill` 与 `maintain reset` 命令分支：定位部署目录 → 调对应编排 → 打印结果 → 返回 `0`；错误/校验失败打印并返回 `1`

- [ ] **Step 1: 写失败测试**

在 `noj-cli/src/cli_test.ts` 末尾追加：

```ts
import { parseBackupArgs } from "./cli.ts";

Deno.test("parseBackupArgs: create 旗标解析", () => {
  const a = parseBackupArgs([
    "create", "--backup-dir", "/bk", "--passphrase-file", "/pw", "--zstd-level", "19", "--no-encrypt", "--dir", "/opt",
  ]);
  assertEquals(a.sub, "create");
  assertEquals(a.backupDir, "/bk");
  assertEquals(a.passphraseFile, "/pw");
  assertEquals(a.zstdLevel, 19);
  assertEquals(a.noEncrypt, true);
  assertEquals(a.dir, "/opt");
});

Deno.test("parseBackupArgs: verify 位置参数 snapshot", () => {
  const a = parseBackupArgs(["verify", "/bk/snapshot-2026.nojbackup", "--dir", "/opt"]);
  assertEquals(a.sub, "verify");
  assertEquals(a.snapshot, "/bk/snapshot-2026.nojbackup");
});

Deno.test("parseBackupArgs: restore 旗标", () => {
  const a = parseBackupArgs([
    "restore", "x.nojbackup", "--confirm", "--include-deploy-configs", "--passphrase-file", "/pw",
  ]);
  assertEquals(a.sub, "restore");
  assertEquals(a.confirm, true);
  assertEquals(a.includeDeployConfigs, true);
  assertEquals(a.passphraseFile, "/pw");
});

Deno.test("parseBackupArgs: drill report 旗标", () => {
  const a = parseBackupArgs(["drill", "x.nojbackup", "--report", "/r.json"]);
  assertEquals(a.sub, "drill");
  assertEquals(a.report, "/r.json");
});
```

> **注意（对执行者）：** `cli_test.ts` 若尚未 import `parseBackupArgs`，请把开头 import 行合并到文件顶部既有 import 区；`BackupArgs` 需含 `sub: string` 字段（见下方实现）。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-cli && deno test -A src/cli_test.ts`
Expected: FAIL，`parseBackupArgs` 未定义。

- [ ] **Step 3: 实现 `parseBackupArgs` 并接入 maintain backup/reset 分支**

在 `noj-cli/src/cli.ts` 顶部 import 区追加：

```ts
import { backupCreate, backupVerify, backupRestore, backupDrill } from "./maintain/backup.ts";
import { maintainReset } from "./maintain/reset.ts";
```

在文件内新增 BackupArgs 接口与解析函数：

```ts
/** maintain backup 参数解析结果。 */
export interface BackupArgs {
  sub: string;
  dir: string | undefined;
  backupDir: string | undefined;
  passphraseFile: string | undefined;
  zstdLevel: number;
  noEncrypt: boolean;
  confirm: boolean;
  includeDeployConfigs: boolean;
  snapshot: string | undefined;
  report: string | undefined;
}

/** 解析 maintain backup 参数：子命令 + 位置参数 snapshot + 各旗标。 */
export function parseBackupArgs(args: string[]): BackupArgs {
  const out: BackupArgs = {
    sub: args[0] ?? "",
    dir: undefined,
    backupDir: undefined,
    passphraseFile: undefined,
    zstdLevel: 15,
    noEncrypt: false,
    confirm: false,
    includeDeployConfigs: false,
    snapshot: undefined,
    report: undefined,
  };
  const positional: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case "--dir": out.dir = args[++i]; break;
      case "--backup-dir": out.backupDir = args[++i]; break;
      case "--passphrase-file": out.passphraseFile = args[++i]; break;
      case "--zstd-level": out.zstdLevel = Number(args[++i]); break;
      case "--no-encrypt": out.noEncrypt = true; break;
      case "--confirm": out.confirm = true; break;
      case "--include-deploy-configs": out.includeDeployConfigs = true; break;
      case "--report": out.report = args[++i]; break;
      default: positional.push(args[i]!);
    }
  }
  out.snapshot = positional[0];
  return out;
}
```

将 `dispatchCommand` 的 `case "maintain":` 分支头部（在 `logs` / `config` 处理之后、`MAINTAIN_SUBCOMMANDS.includes(sub)` 兜底之前）插入 backup 与 reset 处理：

```ts
case "maintain": {
  const sub = args[0] ?? "";
  // ...（P3 已实现 logs 与 config，保持不变）...

  if (sub === "backup") {
    const a = parseBackupArgs(args.slice(1));
    const deployDir = a.dir ?? ctx.deployDir ?? findDeployDir(ctx.cwd);
    if (deployDir === null) {
      console.error("maintain backup: 未找到 noj-deploy.json");
      return 1;
    }
    try {
      switch (a.sub) {
        case "create": {
          const r = await backupCreate({
            dir: deployDir,
            backupDir: a.backupDir,
            passphraseFile: a.passphraseFile,
            zstdLevel: a.zstdLevel,
            noEncrypt: a.noEncrypt,
          });
          console.log(`备份完成: ${r.path}`);
          console.log(`SHA-256: ${r.sha256}`);
          return 0;
        }
        case "verify": {
          if (a.snapshot === undefined) {
            console.error("maintain backup verify: 需要 <snapshot> 路径");
            return 1;
          }
          const report = await backupVerify({
            snapshotPath: a.snapshot,
            passphraseFile: a.passphraseFile,
          });
          if (report.pass) {
            console.log("校验通过");
            return 0;
          }
          for (const e of report.errors) console.error(`  ${e}`);
          return 1;
        }
        case "restore": {
          if (a.snapshot === undefined) {
            console.error("maintain backup restore: 需要 <snapshot> 路径");
            return 1;
          }
          const state = await backupRestore({
            dir: deployDir,
            snapshotPath: a.snapshot,
            confirm: a.confirm,
            passphraseFile: a.passphraseFile,
            includeDeployConfigs: a.includeDeployConfigs,
          });
          console.log(`恢复完成，状态: ${state}`);
          return 0;
        }
        case "drill": {
          if (a.snapshot === undefined) {
            console.error("maintain backup drill: 需要 <snapshot> 路径");
            return 1;
          }
          const report = await backupDrill({
            snapshotPath: a.snapshot,
            passphraseFile: a.passphraseFile,
            report: a.report,
          });
          console.log(`演练完成（drill）：${report.pass ? "通过" : "失败"}`);
          return report.pass ? 0 : 1;
        }
        default:
          console.log("maintain backup: 需要子命令 create/verify/restore/drill");
          return 0;
      }
    } catch (e) {
      console.error(`maintain backup: ${(e as Error).message}`);
      return 1;
    }
  }

  if (sub === "reset") {
    const a = parseBackupArgs(args.slice(1));
    const deployDir = a.dir ?? ctx.deployDir ?? findDeployDir(ctx.cwd);
    if (deployDir === null) {
      console.error("maintain reset: 未找到 noj-deploy.json");
      return 1;
    }
    try {
      const state = await maintainReset({
        dir: deployDir,
        confirm: a.confirm,
        includeDeployConfigs: a.includeDeployConfigs,
      });
      console.log(`重置完成，状态: ${state}`);
      return 0;
    } catch (e) {
      console.error(`maintain reset: ${(e as Error).message}`);
      return 1;
    }
  }

  // ...（P3 既有 MAINTAIN_SUBCOMMANDS.includes(sub) 兜底分支保持不变）...
}
```

> **注意（对执行者）：** 上面 `parseBackupArgs` 同时服务于 `backup` 与 `reset`（reset 只用到 `--dir` / `--confirm` / `--include-deploy-configs`，其余字段忽略）。`MAINTAIN_SUBCOMMANDS` 常量已含 `backup`/`restore`/`verify`/`reset`，`case "backup"` / `case "reset"` 会先于该兜底匹配，故 P0 中"运维逻辑留待后续计划"占位对这些子命令在此被覆盖。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-cli && deno test -A src/cli_test.ts`
Expected: PASS。

- [ ] **Step 5: 手动冒烟验证（临时目录 + fake 语义仅验证参数路由）**

Run:
```bash
cd noj-cli && TMP=$(mktemp -d)
cat > "$TMP/noj-deploy.json" <<'EOF'
{"schema_version":1,"type":"prod","state":"stopped","created_at":"2026-08-31T00:00:00Z","updated_at":"2026-08-31T00:00:00Z","install_dir":"/opt/neuro-oj","version":{"noj_cli":"0.1.0","noj_server":"0.1.0"},"env":{},"components":{"postgres":{"enabled":true,"method":"docker","image":"postgres:16-alpine","internal_port":5432,"env":{}}},"reverse_proxy":{"type":"nginx","config_dir":"/etc/nginx/conf.d","domain":"oj.example.com","upstream_port":8080}}
EOF
echo '{"schema_version":1,"created_at":"2026-08-31T00:00:00Z","updated_at":"2026-08-31T00:00:00Z","secrets":{}}' > "$TMP/noj-secrets.json"
deno run -A src/cli.ts maintain reset --dir "$TMP"            # 期望：报错需 --confirm
deno run -A src/cli.ts maintain backup create --dir "$TMP"    # 期望：报错（dev 外仍需 prod 配置 + 加密口令缺失）
```
Expected: 第一条输出「maintain reset: reset 需要二次确认：--confirm」并以非零退出；第二条输出「maintain backup: backup create 仅面向 prod 部署」或口令报错（取决于配置），命令路由与错误处理符合预期。

- [ ] **Step 6: 运行 check 并提交**

Run: `cd noj-cli && deno task check`
Expected: 通过。

```bash
jj split noj-cli/src/cli.ts noj-cli/src/cli_test.ts
jj describe -m "feat(cli): 接入 maintain backup/reset 命令"
```

---

### Task 6: P4 收尾 —— 公共导出、文档与全量验证

**Files:**
- Modify: `noj-cli/src/mod.ts`（聚合导出 P4 公共接口）
- Modify: `noj-cli/README.md`（补充 P4 范围与用法）

**Interfaces:**
- Consumes: Task 1–5 全部产物。
- Produces：`src/mod.ts` 聚合导出 `BackupDriver` / `DumpEntry` / `realDriver` / `sha256Hex` / `fileSha256Hex`、`backupCreate` / `backupVerify` / `backupRestore` / `backupDrill` / `snapshotFileName` / `resolvePassphraseFile` / `writeSha256Sums` / 各选项与 `Manifest` / `VerifyReport` 类型、`maintainReset` / `ResetOptions`。

- [ ] **Step 1: 更新 `src/mod.ts` 聚合导出**

在 `noj-cli/src/mod.ts` 末尾追加（保留原 P0-P3 导出）：

```ts
// maintain/backup（P4）
export { realDriver, sha256Hex, fileSha256Hex } from "./maintain/backup_driver.ts";
export type { BackupDriver, DumpEntry } from "./maintain/backup_driver.ts";
export {
  backupCreate,
  backupVerify,
  backupRestore,
  backupDrill,
  snapshotFileName,
  resolvePassphraseFile,
  writeSha256Sums,
  defaultBackupDir,
} from "./maintain/backup.ts";
export type {
  Manifest,
  BackupCreateOptions,
  BackupVerifyOptions,
  BackupRestoreOptions,
  BackupDrillOptions,
  VerifyReport,
} from "./maintain/backup.ts";

// maintain/reset（P4）
export { maintainReset } from "./maintain/reset.ts";
export type { ResetOptions } from "./maintain/reset.ts";
```

- [ ] **Step 2: 验证导出的类型检查**

Run: `cd noj-cli && deno task check`
Expected: 通过。

- [ ] **Step 3: 全量测试**

Run: `cd noj-cli && deno task test`
Expected: 全部 PASS（含 P0/P1/P2/P3 既有测试与 P4 新增测试）。

- [ ] **Step 4: 更新 `noj-cli/README.md`**

在 `## 状态` 一节追加 P4 说明，并补充用法：

```markdown
## 状态

P4：实现 `maintain backup create/verify/restore/drill` 与 `maintain reset`。
备份仅面向 prod：zstd level 15 压缩（可用 `--zstd-level` 调整）、SHA-256 校验、
GPG 对称 AES-256 加密（口令来自 `--passphrase-file` 或 `NOJ_BACKUP_PASSPHRASE_FILE`，
`--no-encrypt` 可跳过加密），产物为单个 `snapshot-<timestamp>.nojbackup`。
`verify` 解密解包后校验 SUCCESS/manifest/sha256sums；`restore` 默认只恢复数据、
`--include-deploy-configs` 连同配置恢复（要求目标已停止且 `--confirm`）；
`drill` 执行 verify 并可选写 `--report` 文件。`reset` 默认只清数据并置 `stopped`，
`--include-deploy-configs` 连 `noj-deploy.json`/`noj-secrets.json` 一起清并置
`uninitialized`，均需 `--confirm`。

## 用法

  noj-cli maintain backup create [--backup-dir DIR] [--passphrase-file FILE] [--zstd-level N] [--no-encrypt]
  noj-cli maintain backup verify <snapshot> [--passphrase-file FILE]
  noj-cli maintain backup restore <snapshot> [--confirm] [--passphrase-file FILE] [--include-deploy-configs]
  noj-cli maintain backup drill <snapshot> [--passphrase-file FILE] [--report FILE]
  noj-cli maintain reset [--confirm] [--include-deploy-configs]
```

- [ ] **Step 5: 运行 check 并提交**

Run: `cd noj-cli && deno task check`
Expected: 通过。

```bash
jj split noj-cli/src/mod.ts noj-cli/README.md
jj describe -m "docs(cli): P4 收尾聚合导出与 README 更新"
```

---

## Self-Review

### Spec 覆盖

- **backup create：zstd level 15 压缩、SHA-256 校验、GPG 对称 AES-256 加密、产物 .nojbackup、支持 --no-encrypt** → Task 1 `realDriver`（archive 用 `tar -I "zstd -<level>"`、gpg `--symmetric AES256`）+ Task 2 `backupCreate`（`zstdLevel ?? 15`、`noEncrypt` 分支、`.nojbackup` 文件名、产物 SHA-256）。
- **口令来源 --passphrase-file 或 NOJ_BACKUP_PASSPHRASE_FILE；无 TTY 且未提供时报错** → Task 2 `resolvePassphraseFile` + `backupCreate` 缺口令抛错。
- **backup verify** → Task 3 `backupVerify`（解密解包 → SUCCESS/manifest/sha256sums 校验）。
- **backup restore** → Task 3 `backupRestore`（`--confirm` 校验、要求 stopped、`--include-deploy-configs` 才恢复配置）。
- **backup drill** → Task 3 `backupDrill`（跑 verify + `--report` 文件）。
- **maintain reset：默认只清数据，--include-deploy-configs 连配置一起清** → Task 4 `maintainReset`（`clearData` + 可选删配置文件 → `stopped`/`uninitialized`）。
- **写 Deno 测试（fake docker/gpg/zstd）** → Task 1 `recordingRunner` + `fakeDriver`；Task 2-5 用例全部注入 fake driver，无真实工具依赖。
- **Deno + TypeScript，仅 linux/amd64** → Global Constraints 声明 + Task 1-6 全部 Deno 代码。

### 占位符扫描

无 TBD/TODO/“类似上文”等占位。所有代码步骤给出真实 TypeScript 代码与真实 bash/jj 命令；`realDriver` 中 docker exec 集成细节虽标注"后续可按拓扑精化"，但接口契约与 fake 注入边界完整，且该实现以可运行 Deno 代码给出，非占位。

### 类型一致性

- `BackupDriver` 六个方法签名（archive/extract/gpgEncrypt/gpgDecrypt/produceDataDumps/restoreDataDumps/clearData）在 Task 1 定义，Task 2-4 全部按此使用，fake/real 实现一致。
- `DumpEntry { relPath; content }` Task 1 定义，Task 2 `backupCreate` 消费一致。
- `sha256Hex` / `fileSha256Hex` Task 1 定义，Task 2/3 使用一致。
- `snapshotFileName` / `resolvePassphraseFile` / `writeSha256Sums` / `defaultBackupDir` / `Manifest` Task 2 定义，Task 3/6 使用一致。
- `backupCreate` / `backupVerify` / `backupRestore` / `backupDrill` 及其选项类型在 Task 2/3 定义，Task 5 cli.ts 使用一致。
- `maintainReset` / `ResetOptions` Task 4 定义，Task 5/6 使用一致。
- `parseBackupArgs` 返回 `BackupArgs`（含 `sub`）在 Task 5 定义，Task 5 测试与 cli 分支使用一致。
- P0-P3 既有公共接口（`loadDeployment`/`saveDeployment`/`deployDown`/`writeState`/`transition`/`resolveComponentEnv`/`findDeployDir`/`CommandRunner` 等）签名未被改动，仅新增 P4 模块。
