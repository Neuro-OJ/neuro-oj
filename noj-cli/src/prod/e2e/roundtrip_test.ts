/**
 * noj-cli 真实 E2E（CI 侧）——备份产物的**真实工具链往返**验证。
 *
 * ## 为什么需要它（单测覆盖不到什么）
 *
 * 单元测试用注入的 fake ops / fake runner 覆盖了**编排逻辑**，但有三类问题
 * 只有真实环境才能抓到（本会话已多次出现）：
 *
 * 1. **参数形状与真实 CLI 的兼容性**：`--ansi` 曾被放到 `docker` 而非
 *    `docker compose` 之后（实测 `unknown flag`）；`ss` 端口解析曾误判。
 *    fake runner 永远不会拒绝参数。
 * 2. **产物可用性**：`pg_dump` 的产物必须能被真实 `pg_restore` 读回；
 *    加密封包必须能被自己解开。这是"备份有没有用"的唯一判据，
 *    fake ops 只能证明"代码调用了它"。
 * 3. **格式的隐蔽不兼容**：例如 `pg_dump -Fc` 是自定义格式（`PGDMP` 魔术头），
 *    若被当作文本处理就会静默损坏。
 *
 * ## 运行方式
 *
 * ```bash
 * NOJ_RUN_E2E=1 deno test -A src/prod/e2e/
 * ```
 *
 * 未设 `NOJ_RUN_E2E=1` 时**跳过**（与仓库既有 `noj-tests/e2e` 同一约定）：
 * 本地不一定有 Docker/PostgreSQL，CI 有。
 *
 * ## 环境要求
 *
 * Docker + Compose v2，以及一个可连的 PostgreSQL 与 MinIO 容器
 * （名字可用 `NOJ_E2E_*` 覆盖，缺省对齐 `docker-compose.yml` 的开发服务）。
 *
 * ## 设计约束（重要）
 *
 * **本文件绝不把二进制经 stdout 字符串传递**——那正是 `driver.ts` 明令禁止的
 * 反模式（会损坏含 NUL/0xFF 的 `pg_dump` 产物）。因此：
 * - `pg_dump`/`pg_restore` 都在**容器内**用 `--file` / `-f` 落到容器文件系统，
 *   再由 `docker cp` 搬到宿主机临时目录；
 * - 加密封包的往返用真实文件路径（`gpg --output` / `tar -f`）。
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { realRunner } from "../../runtime/command.ts";
import { makeIdempotentGlobals } from "../backup/globals.ts";
import { writeBackupMetrics } from "../backup/metrics.ts";

/** `NOJ_RUN_E2E=1` 时才真正执行（与 `noj-tests/e2e` 同一约定）。 */
const isE2E = Deno.env.get("NOJ_RUN_E2E") === "1";

/** E2E 用的容器名与凭据（缺省对齐仓库 `docker-compose.yml` 的开发服务）。 */
function e2eEnv(): {
  pgContainer: string;
  pgUser: string;
  pgPassword: string;
  pgDb: string;
  minioContainer: string;
} {
  return {
    pgContainer: Deno.env.get("NOJ_E2E_PG_CONTAINER") ?? "noj-postgres",
    pgUser: Deno.env.get("NOJ_E2E_PG_USER") ?? "noj",
    pgPassword: Deno.env.get("NOJ_E2E_PG_PASSWORD") ?? "noj",
    pgDb: Deno.env.get("NOJ_E2E_PG_DB") ?? "noj",
    minioContainer: Deno.env.get("NOJ_E2E_MINIO_CONTAINER") ?? "noj-minio",
  };
}

const runner = realRunner();

/** 在 PostgreSQL 容器内跑一段 SQL。 */
async function psql(
  sql: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const e = e2eEnv();
  return await runner.run("docker", [
    "exec",
    "-i",
    "-e",
    `PGPASSWORD=${e.pgPassword}`,
    e.pgContainer,
    "psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    e.pgUser,
    "-d",
    e.pgDb,
    "-c",
    sql,
  ]);
}

/** 容器内文件 → 宿主机（**不把二进制经 stdout 字符串**）。 */
async function dockerCpFrom(containerPath: string, hostPath: string) {
  const e = e2eEnv();
  return await runner.run("docker", [
    "cp",
    `${e.pgContainer}:${containerPath}`,
    hostPath,
  ]);
}

Deno.test({
  name: "E2E: pg_dump -Fc 产物可被真实 pg_restore 回灌（备份可用性的核心判据）",
  ignore: !isE2E,
  fn: async () => {
    const e = e2eEnv();
    const root = await Deno.makeTempDir({ prefix: "noj-e2e-pg-" });
    const inContainer = "/tmp/noj-cli-e2e.dump";
    try {
      // 1) 造一张带数据的表
      const create = await psql(
        "DROP TABLE IF EXISTS noj_cli_e2e_probe; " +
          "CREATE TABLE noj_cli_e2e_probe(id serial primary key, note text); " +
          "INSERT INTO noj_cli_e2e_probe(note) VALUES ('alpha'),('beta');",
      );
      assertEquals(
        create.code,
        0,
        `建表失败：${create.stderr.trim() || create.stdout.trim()}`,
      );

      // 2) 容器内 `pg_dump -Fc` 落**文件**（不经 stdout，避免损坏二进制）
      const dump = await runner.run("docker", [
        "exec",
        "-e",
        `PGPASSWORD=${e.pgPassword}`,
        e.pgContainer,
        "pg_dump",
        "-Fc",
        "-U",
        e.pgUser,
        "-d",
        e.pgDb,
        "-f",
        inContainer,
      ]);
      assertEquals(dump.code, 0, `pg_dump 失败：${dump.stderr.trim()}`);

      // 3) `docker cp` 搬出，验证是**自定义格式**（`PGDMP` 魔术头）
      const hostDump = join(root, "postgres.dump");
      const cp = await dockerCpFrom(inContainer, hostDump);
      assertEquals(cp.code, 0, `docker cp 失败：${cp.stderr.trim()}`);
      const head = (await Deno.readFile(hostDump)).slice(0, 5);
      assertEquals(
        new TextDecoder().decode(head),
        "PGDMP",
        "pg_dump -Fc 必须是自定义格式（文本 SQL 会让 pg_restore 无法使用）",
      );

      // 4) 真实 `pg_restore --list` 必须能解析它（T17 的"防静默损坏"判据）
      const list = await runner.run("docker", [
        "exec",
        e.pgContainer,
        "pg_restore",
        "--list",
        inContainer,
      ]);
      assertEquals(
        list.code,
        0,
        `pg_restore --list 失败：${list.stderr.trim()}`,
      );
      assertStringIncludes(
        list.stdout,
        "noj_cli_e2e_probe",
        "清单里必须能看到被备份的表名",
      );

      // 5) 删表 → 真实回灌 → 数据必须回来（"可恢复"的实证）
      assertEquals((await psql("DROP TABLE noj_cli_e2e_probe;")).code, 0);
      const restore = await runner.run("docker", [
        "exec",
        "-e",
        `PGPASSWORD=${e.pgPassword}`,
        e.pgContainer,
        "pg_restore",
        // **必须与生产路径同参数**（`data_restore.ts` 与 bash :369 都是这样）：
        // `--clean --if-exists` 先删既有对象——否则恢复到非空库时会以
        // `schema "drizzle" already exists` 失败。
        // 我第一版漏了这两个旗标，E2E 立刻抓出来（正是本测试存在的意义：
        // 单测的 fake runner 永远不会拒绝参数）。
        "--clean",
        "--if-exists",
        "--no-owner",
        "--exit-on-error",
        "-U",
        e.pgUser,
        "-d",
        e.pgDb,
        inContainer,
      ]);
      assertEquals(
        restore.code,
        0,
        `pg_restore 失败：${restore.stderr.trim()}`,
      );
      const count = await psql(
        "SELECT count(*) FROM noj_cli_e2e_probe;",
      );
      assertEquals(count.code, 0, "回灌后表应存在");
      assertStringIncludes(
        count.stdout,
        "2",
        `回灌后应有 2 行，实得：${count.stdout.trim()}`,
      );
    } finally {
      // 清理容器内临时文件（避免污染后续运行）
      await runner.run("docker", [
        "exec",
        e.pgContainer,
        "rm",
        "-f",
        inContainer,
      ]).catch(() => {});
      await psql("DROP TABLE IF EXISTS noj_cli_e2e_probe;").catch(() => {});
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name:
    "E2E: 真实 gpg + tar + zstd 的整包加密往返（无口令不可读、解码字节一致）",
  ignore: !isE2E,
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "noj-e2e-gpg-" });
    try {
      const staging = join(root, "staging");
      await Deno.mkdir(staging, { recursive: true });
      // 含 NUL / 0xFF 的二进制 + 中文名：验证不经字符串转换
      const payload = new Uint8Array([0x00, 0x01, 0xff, 0xfe, 0x50, 0x47]);
      await Deno.writeFile(join(staging, "postgres.dump"), payload);
      await Deno.writeTextFile(join(staging, "说明.txt"), "中文内容 ✓\n");

      const pass = join(root, "pass");
      await Deno.writeTextFile(pass, "e2e-passphrase-".repeat(4));
      await Deno.chmod(pass, 0o600);

      const tarball = join(root, "payload.tar.zst");
      const t = await runner.run("tar", [
        "-I",
        "zstd",
        "-cf",
        tarball,
        "-C",
        staging,
        ".",
      ]);
      assertEquals(t.code, 0, `tar 失败：${t.stderr.trim()}`);

      const container = join(root, "snap.nojbackup");
      const g = await runner.run("gpg", [
        "--batch",
        "--yes",
        "--pinentry-mode",
        "loopback",
        "--passphrase-file",
        pass,
        "--symmetric",
        "--cipher-algo",
        "AES256",
        "--output",
        container,
        tarball,
      ]);
      assertEquals(g.code, 0, `gpg 加密失败：${g.stderr.trim()}`);

      // **无口令不可读**（R7 P2 在真实产物上的回归）：明文文件名不得出现
      const raw = await Deno.readFile(container);
      const rawText = new TextDecoder("latin1").decode(raw);
      assertEquals(
        rawText.includes("postgres.dump"),
        false,
        "未解密时不得出现明文文件名（整包加密）",
      );
      // 且 `tar` 无法直接读取它（说明确实是加密的，而非仅压缩）
      const asTar = await runner.run("tar", ["-I", "zstd", "-tf", container]);
      assertEquals(asTar.code !== 0, true, "未解密的容器不应能被 tar 直接读取");

      // 正确口令 → 解回 → **逐字节一致**
      const out = join(root, "out.tar.zst");
      const d = await runner.run("gpg", [
        "--batch",
        "--yes",
        "--pinentry-mode",
        "loopback",
        "--passphrase-file",
        pass,
        "--decrypt",
        "--output",
        out,
        container,
      ]);
      assertEquals(d.code, 0, `gpg 解密失败：${d.stderr.trim()}`);
      const back = join(root, "back");
      await Deno.mkdir(back, { recursive: true });
      const u = await runner.run("tar", ["-I", "zstd", "-xf", out, "-C", back]);
      assertEquals(u.code, 0, `tar 解包失败：${u.stderr.trim()}`);
      const restored = await Deno.readFile(join(back, "postgres.dump"));
      assertEquals(
        Array.from(restored),
        Array.from(payload),
        "往返后二进制必须逐字节一致（含 NUL 与 0xFF）",
      );
      assertEquals(
        await Deno.readTextFile(join(back, "说明.txt")),
        "中文内容 ✓\n",
        "中文文件名与内容必须无损",
      );
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name:
    "E2E: 幂等化 globals 可被真实 psql 重放两次（不报 role already exists）",
  ignore: !isE2E,
  fn: async () => {
    // `makeIdempotentGlobals` 的意义就是"重复重放不失败"；只有真实 psql 能证明。
    const root = await Deno.makeTempDir({ prefix: "noj-e2e-globals-" });
    const role = "noj_cli_e2e_role";
    try {
      const src = join(root, "globals.sql");
      await Deno.writeTextFile(src, `-- globals\nCREATE ROLE ${role};\n`);
      const dst = join(root, "idempotent.sql");
      assertEquals(await makeIdempotentGlobals(src, dst), 0);
      const sql = (await Deno.readTextFile(dst)).trim();
      assertStringIncludes(sql, "IF NOT EXISTS");

      // 预清理，保证从"角色不存在"开始
      await psql(`DROP ROLE IF EXISTS ${role};`);

      for (const attempt of [1, 2]) {
        const res = await psql(sql);
        assertEquals(
          res.code,
          0,
          `第 ${attempt} 次重放必须成功（幂等），实得：${
            res.stderr.trim() || res.stdout.trim()
          }`,
        );
      }
    } finally {
      await psql(`DROP ROLE IF EXISTS ${role};`).catch(() => {});
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "E2E: 备份新鲜度指标在真实文件系统上格式与权限正确（监控可采集）",
  ignore: !isE2E,
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "noj-e2e-metrics-" });
    try {
      const backupDir = join(root, "backups");
      await Deno.mkdir(backupDir, { recursive: true });
      await writeBackupMetrics({
        backupDir,
        unixSeconds: 1789819200,
        snapshotBytes: 4096,
      });
      const file = join(backupDir, "metrics", "noj_backup.prom");
      const text = await Deno.readTextFile(file);
      // 告警表达式里的两个指标名必须逐字出现
      assertStringIncludes(text, "noj_backup_last_success_unix_time");
      assertStringIncludes(text, "noj_backup_snapshot_bytes");
      assertEquals(text.includes("# HELP"), true, "需含 HELP 注释");
      assertEquals(text.includes("# TYPE"), true, "需含 TYPE 注释");
      assertEquals(
        (await Deno.stat(file)).mode! & 0o777,
        0o644,
        "node_exporter 以另一用户运行，需可读（644）",
      );
      assertEquals(
        (await Deno.stat(join(backupDir, "metrics"))).mode! & 0o777,
        0o755,
        "指标目录需可进入（755）",
      );
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  },
});
