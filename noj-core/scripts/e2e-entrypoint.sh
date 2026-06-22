#!/bin/sh
set -e

echo ">>> Running database migrations..."
deno task migrate

echo ">>> Seeding data..."
deno task seed

echo ">>> Starting noj-core API server..."
deno task start
