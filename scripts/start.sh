#!/usr/bin/env bash
# Starts the Family Court server. Used by the Sprite service:
#   sprite-env services create court --cmd bash --args /ABS/PATH/family-court/scripts/start.sh --http-port 8080
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data
if [ -f .env ]; then
  set -a; . ./.env; set +a
fi
exec node --import tsx src/main.ts
