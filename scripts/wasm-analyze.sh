#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
exec cargo run --manifest-path "$repo_root/noj-judge/Cargo.toml" --bin wasm-analyze -- "$@"
