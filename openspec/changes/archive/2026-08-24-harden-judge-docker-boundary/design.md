## Context

The worker creates Evaluator and Solution containers through Bollard. Those child containers already drop capabilities, disable privilege escalation, and use a restricted network mode, but the worker previously used Bollard's default `/var/run/docker.sock` connection. The production Compose deployment also mounted that application-host socket and ran the worker as root.

## Goals / Non-Goals

**Goals:**

- Make the Docker endpoint an explicit worker configuration value.
- Allow production to fail before consuming tasks when it is configured with the host socket.
- Make the production Compose deployment use a separately provisioned socket and a non-root worker.
- Make the absence of host mounts and host namespace access visible in the constructed `HostConfig` and regression-tested.

**Non-Goals:**

- Implement a new Docker daemon, VM, gVisor, or Firecracker runtime.
- Treat a socket path string as proof of daemon isolation; the operator remains responsible for provisioning the dedicated/rootless daemon at that path.
- Change the evaluator network capability or the JudgeTask message format.

## Decisions

1. **Use a Unix socket endpoint, configured by `JUDGE_DOCKER_HOST`.**
   The worker only needs the local Docker API today. Supporting a Unix endpoint allows a rootless daemon socket or a socket on a dedicated judge host without adding unauthenticated TCP Docker API support. Unsupported schemes fail at startup.

2. **Gate production with `JUDGE_REQUIRE_ISOLATED_DOCKER`.**
   When enabled, the worker rejects the default host socket (`/var/run/docker.sock` and `/run/docker.sock`). This is a fail-closed deployment guard; it does not attempt to infer the trustworthiness of an arbitrary socket path. Local development keeps the flag off for compatibility.

3. **Run the production worker as non-root with a dedicated socket group.**
   Compose receives the host socket path and group ID from `.env.prod`, mounts the socket at a private container path, and adds only that group to the worker. The application host socket is not a valid default.

4. **Keep the child-container boundary explicit.**
   The shared HostConfig builder sets no host binds, devices, additional capabilities, host PID/IPC/UTS namespaces, or privileged mode. The existing network, readonly root filesystem, tmpfs, pids, memory, and CPU restrictions remain in force.

## Risks / Trade-offs

- [Risk] An operator can mount a host socket at a non-default path. → The guard is documented as a deployment contract, and production provisioning must use a dedicated/rootless daemon with an independent socket owner and host-level review.
- [Risk] Rootless Docker may require host-specific subordinate UID/GID and socket permissions. → The production template exposes the socket path and group ID explicitly and requires a one-worker smoke evaluation before scale-out.
- [Risk] Unix-only endpoint support excludes a direct remote TCP daemon. → Run the Worker on the dedicated judge host or expose a secure local Unix forwarding socket; unauthenticated TCP Docker API is intentionally not accepted.

## Migration Plan

1. Provision a dedicated/rootless Docker daemon for judge workloads and expose its Unix socket at the configured host path.
2. Set `JUDGE_DOCKER_SOCKET`, `JUDGE_DOCKER_SOCKET_GID`, `JUDGE_DOCKER_HOST`, and `JUDGE_REQUIRE_ISOLATED_DOCKER=true`.
3. Pull the new Worker image and start one Worker; verify the Compose configuration, startup Docker PING, and a harmless evaluation.
4. Enable additional Workers only after the smoke evaluation passes.
5. Roll back by restoring the previous Worker image and the same isolated socket configuration; verify labeled orphan containers are cleaned.
