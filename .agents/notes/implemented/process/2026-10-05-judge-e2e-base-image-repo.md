# Agent Note: Judge E2E 测试镜像基础仓库可配置，CI 直连 Docker Hub 并固定 digest

Status: implemented

## Problem

2026-10-05 03:08 前后，#610 / #611 两个纯前端 PR 的 `Judge Sandbox E2E` 同时失败：`noj-judge/tests/e2e/Dockerfile.test-runner` 写死 `FROM docker.m.daocloud.io/library/python:3.12-alpine`，GitHub runner 访问 DaoCloud 镜像代理持续 `TLS handshake timeout`，测试镜像构建失败，`e2e_docker_basic` / `e2e_support_package` / `e2e_dual_container` 等整组失败。`main` 前一天同配置通过，属于第三方镜像代理的可用性问题，但只要依赖它就会复发。

此外 2026-08-15 审计已指出该基础镜像经第三方代理拉取且无 digest，存在投毒 / 漂移风险。

## Decision

- Dockerfile 新增 `ARG PYTHON_IMAGE_REPO`，默认仍为 `docker.m.daocloud.io/library/python`（保证国内本地开发可用），`FROM ${PYTHON_IMAGE_REPO}:3.12-alpine@sha256:1b668429…` 固定 digest。digest 按内容寻址，已实测 Docker Hub 与 DaoCloud 解析到同一 OCI index。
- `tests/common/mod.rs::ensure_test_image` 读取 `NOJ_E2E_PYTHON_IMAGE_REPO`，非空时传 `--build-arg PYTHON_IMAGE_REPO=...`。
- `.github/workflows/e2e.yml` 的 `judge-sandbox` job 设置 `NOJ_E2E_PYTHON_IMAGE_REPO: python`，CI 直连 Docker Hub（`docker/*/Dockerfile` 的其余评测镜像早已直连 Docker Hub 并固定 digest，在 runner 上稳定）。
- 同步更新 `noj-judge/AGENTS.md` 测试基础设施说明；`test-silent-skips.md` 仅行号偏移（324 → 326）。

## Alternatives considered

- **默认改为 Docker Hub**：与其余评测镜像一致，但网络受限的本地开发环境需额外配置才能跑 E2E，影响面更大。
- **CI 配置 Docker daemon registry mirror**：需要改 runner 级 daemon.json 并重启 Docker，比构建参数复杂且对其它 job 有副作用。
- **仅重跑失败 job**：已对 #610 / #611 重跑，但不能防止复发。

## Consequences

- CI 不再依赖 DaoCloud 可用性；本地默认行为不变。
- 升级基础镜像需手动更新 digest（`docker buildx imagetools inspect python:3.12-alpine`）。
- 已在本机验证：两种仓库均可构建；移除本地 `noj-judge-test-runner:latest` 后以 `NOJ_E2E_PYTHON_IMAGE_REPO=python` 运行 `e2e_docker_basic`，`ensure_test_image` 走构建分支且 3 个用例通过（验证后已恢复原本地镜像）。
- `pip install requests urllib3` 仍未锁版本（审计同条目的另一半），不在本次范围。
