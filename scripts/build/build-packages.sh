#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../noj-core"
deno run --allow-read --allow-write --allow-run scripts/build-packages.ts "$@"
