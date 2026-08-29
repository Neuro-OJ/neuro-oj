# 变更提案：增加服务器面板兼容支持

## 背景

部分用户通过宝塔等服务器面板安装和管理 Docker。独立 Judge 部署脚本虽然可以直接调用标准 Docker/Compose 命令，但当前没有说明面板与脚本的关系，用户容易误以为需要面板 API、需要公开 Judge 端口，或误选共享 Docker socket。

## 目标

- 自动识别宝塔面板，并在安装前给出面板用户能理解的操作提示。
- 复用面板管理的标准 Docker/Compose，不依赖不稳定的面板 API。
- 明确脚本不会修改已有站点、反向代理、容器或面板配置。
- 保留专用 rootless Docker socket 的安全约束。
- 在安装帮助和运维文档中说明面板部署边界。

## 非目标

- 不通过宝塔 API 自动创建站点、反向代理或 Docker 应用。
- 不自动安装、升级或替换面板及其 Docker 服务。
- 不把 Judge 的 Docker socket 暴露给面板或公网。

## 方案

增加 `--panel auto|baota|none` 选项，默认自动识别宝塔。识别到宝塔后，以兼容模式运行标准 Docker/Compose 命令，并提示用户可在宝塔 Docker 页面确认 Docker 状态。用户仍需按现有流程提供专用 rootless Docker socket；本机 Redis 仍只绑定回环地址。

## 风险与回滚

该变更只增加检测、提示和帮助文本，不改变既有容器编排逻辑。若面板检测误报，可使用 `--panel none`；若需要强制显示面板提示，可使用 `--panel baota`。回滚时删除面板选项和检测逻辑即可，不影响已有配置与容器。
