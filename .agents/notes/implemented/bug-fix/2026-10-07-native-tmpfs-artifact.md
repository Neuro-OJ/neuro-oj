# Agent Note: Native tmpfs 编译产物读取与 E2E 资源池声明

Status: implemented

## Problem

Native Docker 编译在只读根文件系统和 tmpfs 工作目录中成功，但 Docker
归档接口无法读取运行容器挂载的 tmpfs 文件，导致取回可执行文件时返回 404。现有 AI
全链路测试镜像不包含 WASI SDK，新资源池默认启用全部后端使其在启动校验阶段退出。

## Decision

编译产物通过容器内固定的 `cat /workspace/main` 命令读取，使用独立的 64 MiB
上限、退出码与非空检查。正式测试点输出仍使用原有 32 MiB 上限。读取保留非 root
用户、禁网络和容器生命周期清理，不引入宿主绑定目录或 shell 拼接。真实 Native
Docker 测试同时覆盖标准 IO、文件 IO 及 stderr 不影响 AC。

AI 全链路测试栈明确声明仅启用 `ai` 池和两个任务槽位；WASM 的冻结标准校验、真实
SDK、并行一致性及生产镜像验收继续由独立 Judge 门禁执行。

## Alternatives considered

将编译产物改写到容器根文件系统会破坏只读保护；绑定宿主目录会增加隔离复杂度，因此继续使用
tmpfs。为全部 AI E2E 镜像构建完整 WASI SDK
会重复已有独立验收并增加启动成本，当前测试栈按实际任务类型声明池。

## Consequences

Native 编译成功的产物可从实际挂载命名空间取回，超大或不完整产物明确失败。无 SDK
的 AI 专用 Worker 正常启动，缺少 SDK 的 WASM Worker
仍启动失败。该修改不调整题目预算、评分协议或 WASM 标准。
