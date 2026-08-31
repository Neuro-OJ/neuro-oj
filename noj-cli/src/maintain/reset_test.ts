import { assertEquals, assertRejects } from "@std/assert";
import { loadDeployment } from "../config/load.ts";
import type { DeployConfig, SecretsConfig } from "../config/types.ts";
import type { BackupDriver, DumpEntry } from "./backup_driver.ts";
import type {
  CommandRunner,
  SpawnHandle,
  SpawnOpts,
} from "../runtime/command.ts";
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
    reverse_proxy: {
      type: "nginx",
      config_dir: "/etc/nginx/conf.d",
      domain: "oj.example.com",
      upstream_port: 8080,
    },
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

async function writeFixture(
  dir: string,
  cfg: DeployConfig,
  sec: SecretsConfig,
): Promise<void> {
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

function fakeRunner(): CommandRunner {
  return {
    run() {
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
    spawn(_opts: SpawnOpts): SpawnHandle {
      throw new Error("fake runner 不 spawn");
    },
  };
}

Deno.test("maintainReset: 需 --confirm", async () => {
  const dir = await Deno.makeTempDir();
  await writeFixture(dir, prodConfig(), secrets());
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
  const dir = await Deno.makeTempDir();
  await writeFixture(dir, prodConfig(), secrets());
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
  const dir = await Deno.makeTempDir();
  await writeFixture(dir, prodConfig(), secrets());
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
