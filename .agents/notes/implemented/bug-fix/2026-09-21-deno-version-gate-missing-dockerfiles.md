# Agent Note: Deno 版本门禁只校验 noj-core 的 Dockerfile

Status: implemented

## Problem

`scripts/check-deno-version.ts` 的 Dockerfile 校验写死了一份两项清单：

```ts
for (const df of ["noj-core/Dockerfile", "noj-core/Dockerfile.e2e"]) {
```

但仓库里有 4 个以 `denoland/deno` 为基础镜像的 Dockerfile：

| 文件 | 镜像 |
| --- | --- |
| `noj-core/Dockerfile` | `denoland/deno:debian-2.9.5@sha256:5d46…` |
| `noj-core/Dockerfile.e2e` | `denoland/deno:alpine-2.9.5` |
| `noj-ui/Dockerfile` | `denoland/deno:debian-2.9.5@sha256:5d46…` |
| `noj-llm-gateway/Dockerfile` | `denoland/deno:alpine-2.9.5@sha256:7ef8…` |

触发条件：把 `.dvmrc` 升到 `v2.10.0` 并同步 `noj-core/Dockerfile`，而
`noj-ui` / `noj-llm-gateway` 的 Dockerfile 仍停在 `2.9.5`。

实测（修复前）：

```
$ deno run -A scripts/check-deno-version.ts
Deno 版本一致性检查通过（.dvmrc 为唯一事实源）
```

门禁完全放行。该门禁的建立目标正是"防止运行时版本漂移"（README/注释所述：
Deno 2.9.7 的 BrokenPipe 回归），而生产镜像与 CI 运行时不同版本恰恰是
"本地 / CI 能跑、镜像里挂"的经典来源，属于**门禁自身范围与立项目标不一致**。

## Decision

把"Dockerfile 清单"改为**递归扫描仓库内所有 `Dockerfile*`**（跳过
`node_modules` / `target`），并对每个含 `denoland/deno` 镜像的文件比对
`.dvmrc` 主次版本：

- 新增零输入守卫：一个 Dockerfile 都没扫到时直接报错（避免路径推导失效后
  的假绿）；
- 错误信息改用仓库相对路径（此前直接拼接固定清单名）。

回归用例（`scripts/check-deno-version_test.ts`）新增 2 条：

1. 夹具里让 `noj-ui/Dockerfile` 漂移到 `2.8.1`（core 保持 `2.9.5`），
   断言报错包含 `noj-ui/Dockerfile`；修复前该断言得到 `errors=[]`。
2. 夹具里放一个**嵌套的新模块**路径 `noj-future/deploy/Dockerfile.worker`，
   证明扫描是递归的、不依赖固定清单，防止未来再次写死清单。

## Alternatives considered

1. **只把 `noj-ui/Dockerfile`、`noj-llm-gateway/Dockerfile` 追加进清单**：
   拒绝。这就是把缺陷的模式（手工清单必漂移）再写一遍，新模块仍会逃逸。
   与本次第 3 条（`check-domains` 遗漏 `search`）的修法保持一致：用结构性守卫
   替代逐项登记。
2. **从 `docker-compose.prod.yml` 反推镜像清单**：拒绝。compose 里用的是构建
   上下文而非 FROM 行，无法得到基础镜像标签；且新增模块可能只有 Dockerfile
   而未进 compose，反而造成新的盲区。
3. **把 `@sha256` digest 也纳入一致性校验**：拒绝。digest 与 tag 的对应是
   不可静态推导的，且本门禁只承诺"主次版本一致"，扩大范围会引入误报。

## Consequences

- `noj-ui` / `noj-llm-gateway` 的基础镜像版本自此受 `.dvmrc` 约束；实测当前
  真实仓库 4 个 Dockerfile 全部一致（`2.9`），门禁保持 exit 0。
- 新增模块无论放在哪一层目录，只要文件名以 `Dockerfile` 开头就会被扫描。
