#!/usr/bin/env bash
# Redeploy Family Court to a Sprite. Run from your laptop (not from a Sprite):
#
#   scripts/deploy.sh fc-court            # deploy origin/master
#   SERVICE=court scripts/deploy.sh fc-lawyer
#
# It pulls the latest pushed commit, does a clean install, checks the native SQLite module loads,
# migrates, stamps data/DEPLOY_ID (the mistrial guard refuses checkpoints older than this), restarts
# the service and waits for /healthz. Push first: the Sprite pulls from GitHub, not from your laptop.
set -euo pipefail

NAME="${1:-}"
SERVICE="${SERVICE:-court}"
case "$NAME" in
  fc-court | fc-lawyer | fc-court-dev) ;;
  *)
    echo "usage: scripts/deploy.sh <fc-court | fc-lawyer | fc-court-dev>" >&2
    exit 1
    ;;
esac

command -v sprite >/dev/null || { echo "The sprite CLI isn't installed here (curl -fsSL https://sprites.dev/install.sh | sh)." >&2; exit 1; }

if git rev-parse --git-dir >/dev/null 2>&1; then
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "Note: you have uncommitted changes. The Sprite deploys what's pushed, not your working tree."
  fi
  git fetch -q origin 2>/dev/null || true
  if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/master 2>/dev/null || echo none)" ]; then
    echo "Note: HEAD isn't origin/master. Did you push? (git push origin master)"
  fi
fi

echo "== Deploying to $NAME (service: $SERVICE)"
sprite exec -s "$NAME" -- bash -lc "
  set -euo pipefail
  cd ~/family-court
  git pull --ff-only
  npm ci --no-audit --no-fund
  node -e \"const D = require('better-sqlite3'); new D(':memory:').prepare('select 1').get(); console.log('better-sqlite3 OK (' + process.arch + ')')\"
  npm run -s migrate
  mkdir -p data
  date +%s > data/DEPLOY_ID
  sprite-env services restart $SERVICE
  for i in \$(seq 1 20); do
    if curl -fsS localhost:8080/healthz; then echo; echo 'healthz OK'; exit 0; fi
    sleep 1
  done
  echo 'The service did not answer /healthz. Check /.sprite/logs/services/$SERVICE.log' >&2
  exit 1
"
echo "== $NAME is running $(git rev-parse --short origin/master 2>/dev/null || echo 'the latest push')"
