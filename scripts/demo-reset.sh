#!/usr/bin/env bash
# Start the docket fresh for the demo (RELEASE.md §2). Run INSIDE the Sprite:
#
#   bash scripts/demo-reset.sh            # dry run: show what would be moved
#   bash scripts/demo-reset.sh --apply    # stop the service, back up, clear, restart
#
# Nothing is deleted: court.db, lawyer.db and cached verdict audio move to data/backup-<time>/.
# Box records are not touched (they stay in the private Box account).
set -euo pipefail
cd "$(dirname "$0")/.."
APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1
SERVICE="${SERVICE:-court}"

shopt -s nullglob
items=(data/court.db data/court.db-wal data/court.db-shm data/lawyer.db data/lawyer.db-wal data/lawyer.db-shm data/audio)
present=()
for p in "${items[@]}"; do [ -e "$p" ] && present+=("$p"); done
if [ ${#present[@]} -eq 0 ]; then echo "Nothing to reset: the docket is already empty."; exit 0; fi

cases="$(node -e "try{const D=require('better-sqlite3');console.log(new D('data/court.db',{readonly:true}).prepare('select count(*) n from cases').get().n)}catch{console.log('?')}")"
backup="data/backup-$(date +%Y%m%d-%H%M%S)"
echo "Will move to $backup/ ($cases court case(s)):"
printf '  %s\n' "${present[@]}"
if [ "$APPLY" != 1 ]; then
  echo "Dry run. Nothing changed. Re-run with --apply."
  exit 0
fi

sprite-env services stop "$SERVICE" >/dev/null 2>&1 || true
mkdir -p "$backup"
for p in "${present[@]}"; do mv "$p" "$backup/"; done
npm run -s migrate
sprite-env services start "$SERVICE" >/dev/null 2>&1 || sprite-env services restart "$SERVICE" >/dev/null 2>&1 || true
echo "Done. The docket is empty, cases start at #0001 again, and the old data is in $backup/."
echo "Box still holds the old Case-NNNN.md records; move them to another folder first if you don't want new records to become versions of them."
