# Agent Note: noj-tests 锁文件的镜像 tarball 导致 E2E 门禁失败

Status: implemented

## Problem

`E2E` 的多个 job（Browser / catalog / identity / community / system 等）在读取
`noj-tests/deno.lock` 时**直接失败**，测试根本未开始执行：

```text
error: failed reading lockfile '.../noj-tests/deno.lock'
Caused by:
    The lockfile tarball URL 'https://registry.npmmirror.com/@noble/hashes/-/hashes-2.2.0.tgz'
    for npm package '@noble/hashes@2.2.0' does not match the expected registry origin
    'https://registry.npmjs.org'.
```

该锁文件是 2026-09-06 由一台配置了 npmmirror 镜像的机器生成的，
因此 6 个 npm 包的 `tarball` 字段写死了镜像地址。

**为什么此前未被发现**：失败是 Deno 新版本收紧 `tarball` origin 校验后才出现的
（同一锁文件在旧版本下可正常读取）。这与同期的 CI Deno 版本固定问题是两个
独立缺陷：本 issue 修锁文件内容，Deno 版本固定由另一提交处理。

## Decision

**用官方 registry 重新生成 `noj-tests/deno.lock`**，而不是手工删除 `tarball` 字段。

理由：AGENTS.md §8.1 与 CONTRIBUTING.md 明文「**禁止手动修改 `deno.lock`**」。
手工删字段虽然能让 CI 变绿，但（a）违反红线，（b）会留下手工格式痕迹
（如 `os` 数组被展开成多行，`deno fmt` 与新生成都不会这样排），
（c）不解决「配置镜像的机器重建时又写回镜像地址」的根因。

重新生成的代价是**依赖被提升到 semver 允许的新版本**：

| 包 | 变更 |
| --- | --- |
| `otpauth` | 9.5.1 → 9.5.2（patch） |
| `@noble/hashes` | 2.2.0 → 2.4.0（minor，`otpauth` 的传递依赖） |

两者都满足既有版本范围（`npm:otpauth@9`），且 E2E 全量通过（见下），
因此提升是可接受的；不提升反而只能靠手工编辑，代价更大。

## Alternatives considered

- **手工删除 6 个 `tarball` 字段**：初版做法。这能修好 CI，但违反
  AGENTS.md §8.1/CONTRIBUTING.md 的明文红线，且留下格式漂移痕迹。
  经评审指出后改为重新生成。
- **把 `tarball` 改写成官方 registry 地址**：同样是手工编辑生成文件，同样违规。
- **保持浮动版本、不修锁文件**：失败与锁文件内容直接相关，不修不会自愈。
- **只修锁文件、不固定 Deno 版本**：能解决本次失败，但 CI 仍会在任意
  新版本发布时静默变红；Deno 版本固定是配套的另一项修复。

## Consequences

- 全部 E2E job 恢复可执行（不再在读锁文件阶段失败）。
- 锁文件重新成为**生成器产物**，消除手工编辑痕迹。
- `otpauth` 与 `@noble/hashes` 被提升到 semver 允许的新版本；
  E2E 全量（含 identity 的 TFA 用例）验证通过，未观察到行为回归。
- 根因（配置镜像的机器会再次写回镜像地址）**未被消除**：
  后续若有人在镜像环境下运行 `deno install`，仍可能重新引入。
  彻底防御需要一个「锁文件不得含非官方 registry」的 CI 守卫，本次未做。
