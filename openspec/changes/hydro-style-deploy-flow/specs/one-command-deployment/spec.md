## Purpose

让用户可以像 HydroOJ 一样通过一条命令开始 NOJ
生产部署，同时保留版本固定和已有环境检查能力。

## ADDED Requirements

### Requirement: 远程一键入口

系统 MUST 提供仓库根目录的 `setup.sh` 远程入口；在支持 Bash、下载工具和 Linux
的主机上，用户执行无参数入口时 MUST 启动默认生产安装流程。

#### Scenario: 无参数开始安装

- **WHEN** 用户执行
  `curl -fsSL https://raw.githubusercontent.com/Neuro-OJ/neuro-oj/main/setup.sh | bash`
- **THEN** 系统 MUST 转交到生产安装 bootstrap
- **AND** 系统 MUST 进入环境检测和配置流程
- **AND** 系统 MUST 不要求用户预先记住脚本路径、版本号或管理员邮箱

#### Scenario: 固定版本安装

- **WHEN** 用户执行入口并传入 `--ref <Release tag>`
- **THEN** 系统 MUST 使用指定 ref 下载 bootstrap 和源码
- **AND** 系统 MUST 将指定版本传递给生产部署流程

#### Scenario: 远程入口下载失败

- **WHEN** 入口无法获取实际 bootstrap 脚本
- **THEN** 系统 MUST 返回非零状态
- **AND** 系统 MUST 给出先下载、检查后执行的替代方式

### Requirement: 默认选择最新发布版本

当用户没有显式指定 `--ref` 或 `NOJ_BOOTSTRAP_REF` 时，bootstrap MUST 从仓库
Release 元数据解析最新可用 Release tag，并将其作为默认版本；解析失败 MUST
停止安装。

#### Scenario: 自动使用最新 Release

- **WHEN** GitHub Releases API 返回有效的最新 Release tag
- **THEN** 配置向导的版本默认值 MUST 使用该 tag
- **AND** 生产部署 MUST 继续执行现有版本格式和镜像签名校验

#### Scenario: API 不可用

- **WHEN** GitHub Releases API 无法访问、返回无效数据或没有可用 Release
- **THEN** bootstrap MUST 返回非零状态
- **AND** 输出 MUST 提示使用 `--ref` 显式指定 Release
