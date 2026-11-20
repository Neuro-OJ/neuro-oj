import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { generateReleaseSet } from "./generate-release-set.ts";
import {
  RELEASE_SET_COMPONENT_IMAGES,
  RELEASE_SET_COMPONENTS,
} from "../../noj-cli/src/prod/release-set.ts";

const digest = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}`;

Deno.test("generateReleaseSet: 汇总七个镜像、迁移级别并绑定 Release", async () => {
  const root = await Deno.makeTempDir({ prefix: "noj-release-set-test-" });
  const metadata = join(root, "metadata");
  const core = join(root, "core");
  const gateway = join(root, "gateway");
  try {
    await Deno.mkdir(metadata);
    await Deno.mkdir(core);
    await Deno.mkdir(gateway);
    await Deno.writeTextFile(join(core, "0121_last.sql"), "-- migration\n");
    await Deno.writeTextFile(
      join(gateway, "20261021115820_last.sql"),
      "-- migration\n",
    );
    for (const [index, component] of RELEASE_SET_COMPONENTS.entries()) {
      const image = RELEASE_SET_COMPONENT_IMAGES[component];
      await Deno.writeTextFile(
        join(
          metadata,
          `release-${image.slice(image.lastIndexOf("/") + 1)}.txt`,
        ),
        `${image} v0.10.5 ${digest(String(index + 1))}\n`,
      );
    }

    const result = await generateReleaseSet({
      metadataDir: metadata,
      release: "v0.10.5",
      coreMigrationsDir: core,
      gatewayMigrationsDir: gateway,
    });
    assertEquals(result.release, "v0.10.5");
    assertEquals(result.migration_level, "core:0121,gateway:20261021115820");
    assertEquals(result.components.solution_ai.digest, digest("7"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("generateReleaseSet: 缺失或版本漂移的镜像元数据直接拒绝", async () => {
  const root = await Deno.makeTempDir({ prefix: "noj-release-set-test-" });
  try {
    await assertRejects(
      () =>
        generateReleaseSet({
          metadataDir: root,
          release: "v0.10.5",
          coreMigrationsDir: root,
          gatewayMigrationsDir: root,
        }),
      Error,
      "缺少 core 发布元数据",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
