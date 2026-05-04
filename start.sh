#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
source .env 2>/dev/null || true
exec npx tsx bridge.ts
