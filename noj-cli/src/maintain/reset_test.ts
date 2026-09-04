import { assertEquals, assertRejects } from "@std/assert";
import { loadDeployment } from "../config/load.ts";
import type { BackupDriver, DumpEntry } from "./backup_driver.ts";
import { maintainReset } from "./reset.ts";
import {
  baseConfig,
  failingUpRunner,
  fakeRunner,
  makeTempDir,
  secrets,
  writeFixture,
} from "../testing/helpers.ts";

/** 记录 clearData 调用的 fake driver。 */
function fakeDriver(cleared: string[]): BackupDriver {
  return {
    async archive() {},
    async extract() {},
    async gpgEncrypt() {},
    async gpgDecrypt() {},
    produceDataDumps(): Promise<DumpEntry[]> {
      return Promise.resolve([]);
    },
    async restoreDataDumps() {},
    clearData(_c, _s) {
      cleared.push("data");
      return Promise.resolve();
    },
  };
}

Deno.test("maintainReset: 需 --confirm", async () => {
  const dir = await makeTempDir();
  await writeFixture(
    dir,
    baseConfig({
      components: {
        postgres: {
          enabled: true,
          method: "docker",
          image: "postgres:16-alpine",
          internal_port: 5432,
          env: {},
        },
        redis: {
          enabled: true,
          method: "docker",
          image: "redis:7-alpine",
          internal_port: 6379,
          env: {},
        },
      },
    }),
    secrets(),
  );
  await assertRejects(
    () =>
      maintainReset({
        dir,
        confirm: false,
        driver: fakeDriver([]),
        runner: fakeRunner(),
      }),
    Error,
    "confirm",
  );
});

Deno.test("maintainReset: 默认清数据并置 stopped，保留配置文件", async () => {
  const dir = await makeTempDir();
  await writeFixture(
    dir,
    baseConfig({
      components: {
        postgres: {
          enabled: true,
          method: "docker",
          image: "postgres:16-alpine",
          internal_port: 5432,
          env: {},
        },
        redis: {
          enabled: true,
          method: "docker",
          image: "redis:7-alpine",
          internal_port: 6379,
          env: {},
        },
      },
    }),
    secrets(),
  );
  const cleared: string[] = [];
  const state = await maintainReset({
    dir,
    confirm: true,
    driver: fakeDriver(cleared),
    runner: fakeRunner(),
  });
  assertEquals(state, "stopped");
  assertEquals(cleared, ["data"]);
  const { config } = await loadDeployment(dir);
  assertEquals(config.state, "stopped");
  // 配置文件仍在
  assertEquals(
    await Deno.stat(`${dir}/noj-deploy.json`).then((s) => s.isFile),
    true,
  );
  assertEquals(
    await Deno.stat(`${dir}/noj-secrets.json`).then((s) => s.isFile),
    true,
  );
});

Deno.test("maintainReset: --include-deploy-configs 连配置一起清，置 uninitialized", async () => {
  const dir = await makeTempDir();
  await writeFixture(
    dir,
    baseConfig({
      components: {
        postgres: {
          enabled: true,
          method: "docker",
          image: "postgres:16-alpine",
          internal_port: 5432,
          env: {},
        },
        redis: {
          enabled: true,
          method: "docker",
          image: "redis:7-alpine",
          internal_port: 6379,
          env: {},
        },
      },
    }),
    secrets(),
  );
  const cleared: string[] = [];
  const state = await maintainReset({
    dir,
    confirm: true,
    includeDeployConfigs: true,
    driver: fakeDriver(cleared),
    runner: fakeRunner(),
  });
  assertEquals(state, "uninitialized");
  assertEquals(cleared, ["data"]);
  // 配置文件被删除
  await assertRejects(() => Deno.stat(`${dir}/noj-deploy.json`), Error);
  await assertRejects(() => Deno.stat(`${dir}/noj-secrets.json`), Error);
});

Deno.test("maintainReset: 基础设施启动失败时仍执行 down 清理", async () => {
  const dir = await makeTempDir();
  await writeFixture(
    dir,
    baseConfig({
      components: {
        postgres: {
          enabled: true,
          method: "docker",
          image: "postgres:16-alpine",
          internal_port: 5432,
          env: {},
        },
        redis: {
          enabled: true,
          method: "docker",
          image: "redis:7-alpine",
          internal_port: 6379,
          env: {},
        },
      },
    }),
    secrets(),
  );
  const downCalls: number[] = [];
  await assertRejects(
    () =>
      maintainReset({
        dir,
        confirm: true,
        driver: fakeDriver([]),
        runner: failingUpRunner(downCalls),
      }),
    Error,
    "启动基础设施失败",
  );
  assertEquals(downCalls.length >= 1, true);
});
