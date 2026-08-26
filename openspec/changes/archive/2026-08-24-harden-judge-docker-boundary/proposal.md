## Why

`noj-judge` currently connects to the default Docker socket, and a production deployment can expose the host daemon to the long-running worker process. A compromise of that process would therefore have a daemon-level escape path that is wider than the intended per-evaluation sandbox.

## What Changes

- Add an explicit, configurable Unix Docker endpoint for `noj-judge`.
- Add a fail-closed isolation mode that rejects the default host Docker socket and unsupported endpoint schemes at startup.
- Make evaluation container creation explicitly omit host binds, devices, host namespaces, and privilege-escalation options.
- Change production Compose to mount only a separately provisioned rootless/judge-host Docker socket and run the Worker as a non-root user.
- Add regression tests for the endpoint guard and container host-boundary configuration.
- Document the production requirement to use a dedicated rootless or separately isolated Docker daemon, with verification and rollback guidance.

## Capabilities

### New Capabilities

- `judge-docker-boundary`: Define the Docker daemon endpoint guard and the host-boundary guarantees for evaluation containers.

### Modified Capabilities


## Impact

- `noj-judge` configuration, startup connection code, Dockerfile, and Compose runtime settings.
- Docker `HostConfig` construction and its unit tests.
- Judge operator and production deployment documentation.
- No API, database schema, or message-format changes.
