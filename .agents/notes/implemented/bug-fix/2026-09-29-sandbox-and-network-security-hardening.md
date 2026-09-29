# Agent Note: 沙箱隔离、网络拓扑与容器安全加固（Batch 2）

Status: implemented

## Problem

在沙箱隔离与容器逃逸防御的专项审查中，确认了 4 项关键安全漏洞：
1. `TI-01`：`docker-compose.prod.yml` 与 `noj-cli` 模板中的 `noj-eval-net` 网络定义缺少 `internal: true`，导致接入该网络的 Evaluator 沙箱容器默认拥有出站 SNAT/MASQUERADE 访问外部互联网的能力，严重破坏隔离边界；
2. `SE-01`：`noj-download://local` 协议允许直接复制宿主机本地任意 `.zip` 文件，生产环境若存在恶意伪造的评测任务，可能造成宿主机文件系统未授权窥探；
3. `SE-02`：`noj-download://s3` 缺乏对私网网段与云元数据服务器的校验，若 S3 下载 URL 指向 `169.254.169.254`（云厂商 IMDS）、`127.0.0.1` 等内部保留地址，将引发高危 SSRF 导致云实例凭据被盗；
4. `SE-03`：评测容器创建（`ContainerCreateBody`）与用户代码执行（`ExecConfig`）未显式指定非 root UID，若镜像默认配置存在疏漏，容器将以 root (UID 0) 权限运行。

## Decision

针对上述安全缺陷，完成以下纵深防御加固：
1. **沙箱物理隔离收口（TI-01）**：在 `docker-compose.prod.yml` 与 `noj-cli/src/prod/judge/compose.ts` 的 `noj-eval-net` 网络定义中追加 `internal: true`，彻底阻断 Evaluator 出公网能力与横向探测；
2. **本地协议生产熔断（SE-01）**：在 `noj-judge/src/sandbox/download.rs` 中收紧 `local` 协议，除测试环境或显式指定 `JUDGE_ALLOW_LOCAL_DOWNLOAD=true` 外，生产默认直接拒绝并报错；
3. **S3 SSRF 严格防护（SE-02）**：在 `download.rs` 中增加 `validate_s3_host_not_ssrf`，严格校验下载 URL 的 Host，拦截 `127.0.0.0/8`、`169.254.0.0/16`、`::1`、`instance-data` 及 `metadata.*` 等全部云元数据和环回地址；
4. **沙箱非 root 强制降权（SE-03）**：定义 `SANDBOX_USER = "10001:10001"`，并在 `ContainerCreateBody` 与 `start_exec` 的 `ExecConfig` 中强制配置 `user: Some(SANDBOX_USER.to_string())`，从引擎底层锁死非 root 权限。

## Alternatives considered

- 在路由层完全移除 `noj-download://local`：考虑到开发者在本地无 S3/MinIO 环境下的极速回归与冒烟测试需求，保留 `JUDGE_ALLOW_LOCAL_DOWNLOAD` 开关并在生产默认 fail-closed 阻断，兼顾安全与开发体验。

## Consequences

- Evaluator 容器无法直连公网或探测内网核心组件，所有模型交互被物理强制走受控的 `llm-gateway`；
- S3 支持包下载不再可能被利用探测云宿主机元数据或内网环回服务；
- 评测容器与 exec 进程在 Docker 引擎层面强制以 UID 10001 运行，防御容器逃逸与提权；
- `cargo test`、`cargo clippy`、`deno task check` 全绿通过。
