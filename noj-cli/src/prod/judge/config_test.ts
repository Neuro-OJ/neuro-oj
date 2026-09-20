// ── 评审发现（Critical）：共享 socket 守卫可被尾部斜杠绕过 ────────────
//
// `assertDedicatedSocket` 只比较字面量、`collapseSlashes` 与 `realpath`，
// 而 `collapseSlashes` **不处理尾部斜杠**、`realPath("/var/run/docker.sock/")`
// 又因 NotADirectory 返回 ""（被当作"路径不存在，跳过"）。于是这些写法全部放行：
//
//   /var/run/docker.sock/     /run/docker.sock/
//   /var/run/docker.sock/.    /run/docker.sock/./
//
// 实测（真实 Docker）：尾部斜杠的 bind **源**同样会挂载宿主路径——
// 即一个手误的斜杠就能把应用宿主机 socket 交给 Judge，正是本模块存在的意义所在。
// 守卫的价值**全在负空间**（能否拒绝），所以这里用表驱动把变体钉死。

import { assertThrows } from "@std/assert";
import { UsageError } from "../../util/args.ts";

Deno.test("评审: 共享 socket 守卫必须拒绝尾部斜杠/点段等一切等价写法", async () => {
  const { assertDedicatedSocket } = await import("./config.ts");
  const bypasses = [
    "/var/run/docker.sock/",
    "/run/docker.sock/",
    "/var/run/docker.sock/.",
    "/var/run/docker.sock/./",
    "/run/docker.sock/./",
    "//var/run/docker.sock",
    "//run//docker.sock//",
    "/var/run/docker.sock/..//docker.sock",
    "/run/./docker.sock",
  ];
  for (const p of bypasses) {
    assertThrows(
      () => assertDedicatedSocket(p, () => ""),
      UsageError,
      undefined,
      `必须拒绝等价写法 ${
        JSON.stringify(p)
      }（尾部斜杠/点段不改变它指向宿主 socket 的事实）`,
    );
  }
});

Deno.test("评审: 共享 socket 守卫对 realpath 抛错的输入也不放行", async () => {
  const { assertDedicatedSocket } = await import("./config.ts");
  // 真实 Deno.realPathSync 对 `/var/run/docker.sock/` 抛 NotADirectory；
  // 守卫必须自己归一化，不能依赖 realpath 成功。
  assertThrows(
    () => assertDedicatedSocket("/var/run/docker.sock/"),
    UsageError,
  );
});

Deno.test("评审: 专用 socket 的合法写法仍放行（不误伤）", async () => {
  const { assertDedicatedSocket } = await import("./config.ts");
  for (
    const ok of [
      "/run/noj-judge/docker.sock",
      "/run/noj-judge/docker.sock/",
      "/var/run/noj-judge/docker.sock",
      "/tmp/rootless/docker.sock",
    ]
  ) {
    assertDedicatedSocket(ok, () => "");
  }
});
