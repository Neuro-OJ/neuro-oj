#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../noj-core"
deno run --allow-net --allow-env --allow-read --allow-write scripts/seed.ts "$@"
