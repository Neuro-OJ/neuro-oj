#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../noj-core"
deno run -A scripts/migrate.ts "$@"
