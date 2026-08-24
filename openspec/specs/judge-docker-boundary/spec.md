## Purpose

为 noj-judge 建立 Docker daemon 与评测子容器之间可验证、可失败闭环的权限边界，降低评测进程或恶意代码影响宿主机及其他服务的风险。

## Requirements

### Requirement: Docker daemon endpoint isolation

`noj-judge` SHALL accept a configured Unix Docker endpoint through `JUDGE_DOCKER_HOST`. When `JUDGE_REQUIRE_ISOLATED_DOCKER=true`, startup MUST reject the default host Docker socket (`/var/run/docker.sock` or `/run/docker.sock`) and MUST reject any endpoint scheme other than `unix://` before consuming judge tasks.

#### Scenario: Development uses the default local daemon

- **WHEN** `JUDGE_REQUIRE_ISOLATED_DOCKER` is unset or false and `JUDGE_DOCKER_HOST` is unset
- **THEN** the worker connects to the default local Docker socket for development compatibility

#### Scenario: Production rejects the host socket

- **WHEN** `JUDGE_REQUIRE_ISOLATED_DOCKER=true` and `JUDGE_DOCKER_HOST` points to `/var/run/docker.sock` or `/run/docker.sock`
- **THEN** the worker exits with a configuration error before pulling any judge task

#### Scenario: Unsupported endpoint is rejected

- **WHEN** `JUDGE_DOCKER_HOST` uses a non-Unix scheme such as `tcp://` or `http://`
- **THEN** the worker exits with a configuration error before connecting to Docker

### Requirement: Evaluation containers cannot request host access

Every Evaluator and Solution container created by `noj-judge` MUST have no host bind, device, additional capability, privileged mode, or host PID/IPC/UTS namespace configuration. The container configuration MUST retain the existing network, no-new-privileges, resource, and filesystem restrictions.

#### Scenario: Host boundary fields are absent

- **WHEN** the worker builds HostConfig for an evaluation container
- **THEN** binds, devices, volumes-from, cap-add, privileged, pid-mode, ipc-mode, and uts-mode do not grant host access

#### Scenario: Evaluation code probes sensitive host paths

- **WHEN** solution code checks for `/var/run/docker.sock`, `/var/lib/docker`, or an injected `/host` mount
- **THEN** those host resources are not present in the evaluation container

### Requirement: Secure deployment is documented and verifiable

Production deployment documentation MUST require a dedicated rootless Docker daemon or a separately isolated judge host, forbid mounting the application host Docker socket into `noj-judge`, and describe startup verification, upgrade, and rollback checks.

#### Scenario: Operator prepares a production worker

- **WHEN** an operator follows the judge deployment checklist
- **THEN** the worker is configured with a dedicated Unix socket, isolation mode is enabled, and a harmless evaluation is verified before more workers are enabled

#### Scenario: Operator rolls back

- **WHEN** a worker image or daemon configuration must be rolled back
- **THEN** the operator can stop workers, restore the prior image/configuration, and verify labeled orphan containers are cleaned without changing application data
