# Agent Note: OI Docker 工作目录显式允许执行

Status: implemented

## Problem

本地通过导入、提交、Redis 和 Judge 的真实链路验证时，C/C++
正确程序编译成功后被判为 RE。Docker 默认给 tmpfs 挂载添加 noexec，省略 noexec
并不能使工作目录可执行。

## Decision

OI Docker 工作目录的 tmpfs 显式指定 exec，保留 nosuid、nodev、只读根目录、非
root 用户和禁网配置。新增真实 Docker 回归测试，编译并运行 C++ A+B，断言最终
verdict 为 AC。

## Alternatives considered

不使用可写宿主目录或可写根目录存放二进制，避免扩大选手代码的可写范围；不以检查挂载选项字符串代替真实执行验收。

## Consequences

本地 Docker 回退可运行编译产物；临时目录 /tmp 继续 noexec。真实回归需要
noj-oi-cpp 镜像、Docker 和 NOJ_RUN_E2E=1，常规测试默认忽略；Judge Sandbox E2E
构建原生镜像并运行该回归。完整 HTTP 验收覆盖 C/C++ AC、WA、CE、TLE
及题目批量重测。
