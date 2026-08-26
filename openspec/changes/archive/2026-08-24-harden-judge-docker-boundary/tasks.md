## 1. Worker Docker endpoint guard

- [x] 1.1 Add `JUDGE_DOCKER_HOST` and `JUDGE_REQUIRE_ISOLATED_DOCKER` configuration with safe parsing and verify default/custom/invalid values using Rust unit tests
- [x] 1.2 Replace the implicit local Docker connection with the guarded Unix endpoint connector and verify secure mode fails before task consumption for host sockets and unsupported schemes

## 2. Evaluation host boundary

- [x] 2.1 Make the evaluation `HostConfig` explicitly deny host binds, devices, extra capabilities, privileged mode, and host namespaces while preserving existing limits; verify all fields with unit tests
- [x] 2.2 Add or extend the Docker security regression test to verify evaluation containers do not expose the Docker socket, host filesystem mount, or Docker data directory when the E2E guard is enabled

## 3. Production deployment

- [x] 3.1 Change production Compose and the Judge Dockerfile to mount only a separately provisioned socket and run the worker as non-root; verify Compose requires the socket path/group configuration
- [x] 3.2 Document dedicated/rootless daemon provisioning, required environment variables, startup verification, upgrade, rollback, and orphan cleanup checks in judge operator documentation

## 4. Verification

- [x] 4.1 Run `cargo fmt --check`, `cargo test`, and the available Docker security E2E tests; run strict OpenSpec validation
